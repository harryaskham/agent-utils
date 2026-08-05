use anyhow::{Context, Result};
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::Value;

use crate::model::{
    Account, Address, CacheState, CalendarEvent, Channel, Chat, ChatMessage, MailMessage, Team,
};
use crate::workiq::WorkIqClient;

const MAIL_SELECT: &str = "id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,body,isRead,importance,hasAttachments,conversationId,webLink,parentFolderId";
const EVENT_SELECT: &str = "id,subject,organizer,attendees,start,end,location,bodyPreview,body,responseStatus,isOnlineMeeting,onlineMeeting,webLink,seriesMasterId,isCancelled";
const CHAT_SELECT: &str = "id,topic,chatType,lastUpdatedDateTime,webUrl";
const CHAT_MESSAGE_SELECT: &str =
    "id,createdDateTime,lastModifiedDateTime,from,body,messageType,replyToId,webUrl,importance";
const TEAM_SELECT: &str = "id,displayName,description,webUrl";
const CHANNEL_SELECT: &str = "id,displayName,description,membershipType,webUrl";

#[derive(Clone)]
pub struct WorkIqService {
    client: WorkIqClient,
}

impl WorkIqService {
    #[must_use]
    pub fn new(client: WorkIqClient) -> Self {
        Self { client }
    }

    pub fn refresh_identity(&self, state: &mut CacheState) -> Result<()> {
        let result = self.fetch_one("/me?$select=id,displayName,mail,userPrincipalName")?;
        state.account = Account {
            id: string(&result, "id"),
            display_name: string(&result, "displayName"),
            mail: string(&result, "mail"),
            user_principal_name: string(&result, "userPrincipalName"),
        };
        state.mark_refreshed("identity");
        Ok(())
    }

    /// Advance one bounded inbox delta page. The first cycle performs Graph's
    /// initial backfill; subsequent cycles reuse the opaque delta cursor.
    pub fn refresh_mail_folder(&self, state: &mut CacheState, folder: &str) -> Result<bool> {
        let key = format!("mail:{folder}");
        let path = state.cursors.get(&key).cloned().unwrap_or_else(|| {
            format!("/me/mailFolders/{folder}/messages/delta()?$select={MAIL_SELECT}&$top=100")
        });
        let data = self.fetch_one(&path)?;
        let page = parse_page(&data, |item| parse_mail(item, folder));
        if !page.removed.is_empty() {
            state
                .mail
                .retain(|message| !page.removed.contains(&message.id));
        }
        state.merge_mail(page.items);
        let complete = apply_cursor(state, &key, page.next, page.delta);
        if complete {
            state.mark_refreshed(key);
        }
        Ok(complete)
    }

    /// Refresh the rolling calendar window for deterministic agenda views.
    pub fn refresh_calendar_view(
        &self,
        state: &mut CacheState,
        past_days: u32,
        future_days: u32,
    ) -> Result<()> {
        let start = (Utc::now() - Duration::days(i64::from(past_days)))
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        let end = (Utc::now() + Duration::days(i64::from(future_days)))
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        let path = format!(
            "/me/calendarView?startDateTime={}&endDateTime={}&$select={EVENT_SELECT}&$orderby=start/dateTime&$top=200",
            encode(&start),
            encode(&end)
        );
        let data = self.fetch_one(&path)?;
        let page = parse_page(&data, parse_event);
        if !page.removed.is_empty() {
            state
                .events
                .retain(|event| !page.removed.contains(&event.id));
        }
        state.merge_events(page.items);
        state.mark_refreshed("calendar");
        Ok(())
    }

    /// Maintain an event delta cursor in addition to the bounded calendarView;
    /// this catches updates/deletions without waiting for a full window poll.
    pub fn refresh_event_delta(&self, state: &mut CacheState) -> Result<bool> {
        let key = "calendar:delta";
        let path = state
            .cursors
            .get(key)
            .cloned()
            .unwrap_or_else(|| format!("/me/events/delta()?$select={EVENT_SELECT}&$top=100"));
        let data = self.fetch_one(&path)?;
        let page = parse_page(&data, parse_event);
        if !page.removed.is_empty() {
            state
                .events
                .retain(|event| !page.removed.contains(&event.id));
        }
        state.merge_events(page.items);
        let complete = apply_cursor(state, key, page.next, page.delta);
        if complete {
            state.mark_refreshed(key);
        }
        Ok(complete)
    }

    pub fn refresh_chats(&self, state: &mut CacheState) -> Result<()> {
        let data = self.fetch_one(&format!(
            "/me/chats?$select={CHAT_SELECT}&$orderby=lastUpdatedDateTime desc&$top=100"
        ))?;
        let mut chats = values(&data)
            .iter()
            .map(parse_chat)
            .filter(|chat| !chat.id.is_empty())
            .collect::<Vec<_>>();
        // Resolve names once per inventory refresh. WorkIQ documents that the
        // members endpoint does not support $top.
        let paths = chats
            .iter()
            .map(|chat| {
                format!(
                    "/me/chats/{}/members?$select=displayName,email,userId",
                    encode_segment(&chat.id)
                )
            })
            .collect::<Vec<_>>();
        if !paths.is_empty() {
            for (chat, result) in chats.iter_mut().zip(self.client.fetch(paths)?) {
                let data = result.get("data").cloned().unwrap_or(Value::Null);
                chat.members = values(&data).iter().map(parse_member).collect();
            }
        }
        state.chats = chats;
        state.normalize();
        state.mark_refreshed("chats");
        Ok(())
    }

    pub fn refresh_chat_messages(&self, state: &mut CacheState, chat_id: &str) -> Result<bool> {
        let key = format!("chat:{chat_id}");
        let path = state.cursors.get(&key).cloned().unwrap_or_else(|| {
            format!(
                "/me/chats/{}/messages/delta()?$select={CHAT_MESSAGE_SELECT}&$top=100",
                encode_segment(chat_id)
            )
        });
        let data = self.fetch_one(&path)?;
        let page = parse_page(&data, parse_chat_message);
        if !page.removed.is_empty() {
            let removed = &page.removed;
            state
                .chat_messages
                .entry(chat_id.to_string())
                .or_default()
                .retain(|message| !removed.contains(&message.id));
        }
        state.merge_chat_messages(chat_id, page.items);
        let complete = apply_cursor(state, &key, page.next, page.delta);
        if complete {
            state.mark_refreshed(key);
        }
        Ok(complete)
    }

    pub fn refresh_teams(&self, state: &mut CacheState) -> Result<()> {
        let data = self.fetch_one(&format!("/me/joinedTeams?$select={TEAM_SELECT}&$top=100"))?;
        state.teams = values(&data)
            .iter()
            .map(parse_team)
            .filter(|team| !team.id.is_empty())
            .collect();
        let paths = state
            .teams
            .iter()
            .map(|team| {
                format!(
                    "/teams/{}/channels?$select={CHANNEL_SELECT}&$top=100",
                    encode_segment(&team.id)
                )
            })
            .collect::<Vec<_>>();
        let mut channels = std::collections::BTreeMap::new();
        if !paths.is_empty() {
            for (team, result) in state.teams.iter().zip(self.client.fetch(paths)?) {
                let data = result.get("data").cloned().unwrap_or(Value::Null);
                channels.insert(
                    team.id.clone(),
                    values(&data)
                        .iter()
                        .map(|item| parse_channel(item, &team.id))
                        .collect(),
                );
            }
        }
        state.channels = channels;
        state.mark_refreshed("teams");
        Ok(())
    }

    pub fn refresh_channel_messages(
        &self,
        state: &mut CacheState,
        team_id: &str,
        channel_id: &str,
    ) -> Result<bool> {
        let key = format!("channel:{team_id}:{channel_id}");
        let path = state.cursors.get(&key).cloned().unwrap_or_else(|| {
            format!(
                "/teams/{}/channels/{}/messages/delta()?$select={CHAT_MESSAGE_SELECT}&$top=100",
                encode_segment(team_id),
                encode_segment(channel_id)
            )
        });
        let data = self.fetch_one(&path)?;
        let page = parse_page(&data, parse_chat_message);
        if !page.removed.is_empty() {
            let removed = &page.removed;
            state
                .channel_messages
                .entry(key.clone())
                .or_default()
                .retain(|message| !removed.contains(&message.id));
        }
        state.merge_channel_messages(&key, page.items);
        let complete = apply_cursor(state, &key, page.next, page.delta);
        if complete {
            state.mark_refreshed(key);
        }
        Ok(complete)
    }

    #[must_use]
    pub fn client(&self) -> &WorkIqClient {
        &self.client
    }

    fn fetch_one(&self, path: &str) -> Result<Value> {
        let result = self
            .client
            .fetch(vec![normalize_entity_url(path)])?
            .into_iter()
            .next()
            .context("WorkIQ returned no fetch result")?;
        result
            .get("data")
            .cloned()
            .context("WorkIQ fetch result has no data")
    }
}

struct Page<T> {
    items: Vec<T>,
    removed: Vec<String>,
    next: Option<String>,
    delta: Option<String>,
}

fn parse_page<T>(data: &Value, parse: impl Fn(&Value) -> T) -> Page<T> {
    let mut items = Vec::new();
    let mut removed = Vec::new();
    for item in values(data) {
        let id = string(item, "id");
        if item.get("@removed").is_some() {
            if !id.is_empty() {
                removed.push(id);
            }
        } else {
            items.push(parse(item));
        }
    }
    Page {
        items,
        removed,
        next: data
            .get("@odata.nextLink")
            .and_then(Value::as_str)
            .map(normalize_entity_url),
        delta: data
            .get("@odata.deltaLink")
            .and_then(Value::as_str)
            .map(normalize_entity_url),
    }
}

fn apply_cursor(
    state: &mut CacheState,
    key: &str,
    next: Option<String>,
    delta: Option<String>,
) -> bool {
    if let Some(next) = next {
        state.cursors.insert(key.to_string(), next);
        false
    } else if let Some(delta) = delta {
        state.cursors.insert(key.to_string(), delta);
        true
    } else {
        // Non-delta collection endpoints are complete after one bounded fetch.
        true
    }
}

fn parse_mail(value: &Value, folder: &str) -> MailMessage {
    MailMessage {
        id: string(value, "id"),
        subject: string(value, "subject"),
        from: parse_email(value.get("from").unwrap_or(&Value::Null)),
        to: value
            .get("toRecipients")
            .and_then(Value::as_array)
            .map_or_else(Vec::new, |items| items.iter().map(parse_email).collect()),
        received_at: string(value, "receivedDateTime"),
        sent_at: string(value, "sentDateTime"),
        body_preview: string(value, "bodyPreview"),
        body_markdown: body_markdown(value.get("body")),
        is_read: value
            .get("isRead")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        importance: string(value, "importance"),
        has_attachments: value
            .get("hasAttachments")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        conversation_id: string(value, "conversationId"),
        web_link: string(value, "webLink"),
        folder: folder.into(),
    }
}

fn parse_event(value: &Value) -> CalendarEvent {
    let start = value.get("start").unwrap_or(&Value::Null);
    let end = value.get("end").unwrap_or(&Value::Null);
    CalendarEvent {
        id: string(value, "id"),
        subject: string(value, "subject"),
        organizer: parse_email(value.get("organizer").unwrap_or(&Value::Null)),
        attendees: value
            .get("attendees")
            .and_then(Value::as_array)
            .map_or_else(Vec::new, |items| items.iter().map(parse_email).collect()),
        start: normalize_datetime(&string(start, "dateTime")),
        end: normalize_datetime(&string(end, "dateTime")),
        timezone: string(start, "timeZone"),
        location: value
            .get("location")
            .map(|location| string(location, "displayName"))
            .unwrap_or_default(),
        body_preview: string(value, "bodyPreview"),
        body_markdown: body_markdown(value.get("body")),
        response_status: value
            .get("responseStatus")
            .map(|status| string(status, "response"))
            .unwrap_or_default(),
        is_online_meeting: value
            .get("isOnlineMeeting")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        join_url: value
            .get("onlineMeeting")
            .map(|meeting| string(meeting, "joinUrl"))
            .unwrap_or_default(),
        web_link: string(value, "webLink"),
        series_master_id: string(value, "seriesMasterId"),
        is_cancelled: value
            .get("isCancelled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn parse_chat(value: &Value) -> Chat {
    Chat {
        id: string(value, "id"),
        topic: string(value, "topic"),
        chat_type: string(value, "chatType"),
        updated_at: string(value, "lastUpdatedDateTime"),
        web_url: string(value, "webUrl"),
        members: Vec::new(),
    }
}

fn parse_member(value: &Value) -> Address {
    Address {
        name: string(value, "displayName"),
        address: string(value, "email"),
    }
}

fn parse_chat_message(value: &Value) -> ChatMessage {
    let from = value.get("from").unwrap_or(&Value::Null);
    let sender = from
        .get("user")
        .or_else(|| from.get("application"))
        .or_else(|| from.get("device"))
        .unwrap_or(from);
    ChatMessage {
        id: string(value, "id"),
        created_at: string(value, "createdDateTime"),
        modified_at: string(value, "lastModifiedDateTime"),
        from: Address {
            name: string(sender, "displayName"),
            address: string(sender, "id"),
        },
        body_markdown: body_markdown(value.get("body")),
        message_type: string(value, "messageType"),
        reply_to_id: string(value, "replyToId"),
        web_url: string(value, "webUrl"),
        importance: string(value, "importance"),
        deleted: value.get("@removed").is_some()
            || string(value, "messageType").eq_ignore_ascii_case("deleted"),
    }
}

fn parse_team(value: &Value) -> Team {
    Team {
        id: string(value, "id"),
        display_name: string(value, "displayName"),
        description: string(value, "description"),
        web_url: string(value, "webUrl"),
    }
}

fn parse_channel(value: &Value, team_id: &str) -> Channel {
    Channel {
        id: string(value, "id"),
        team_id: team_id.into(),
        display_name: string(value, "displayName"),
        description: string(value, "description"),
        membership_type: string(value, "membershipType"),
        web_url: string(value, "webUrl"),
    }
}

fn parse_email(value: &Value) -> Address {
    let email = value.get("emailAddress").unwrap_or(value);
    Address {
        name: string(email, "name"),
        address: string(email, "address"),
    }
}

fn body_markdown(body: Option<&Value>) -> String {
    let Some(body) = body else {
        return String::new();
    };
    let content = string(body, "content");
    if string(body, "contentType").eq_ignore_ascii_case("html") {
        html2md::parse_html(&content)
    } else {
        content
    }
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn values(value: &Value) -> &[Value] {
    value
        .get("value")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn normalize_datetime(value: &str) -> String {
    if value.is_empty() || value.ends_with('Z') || value.contains('+') {
        value.to_string()
    } else {
        format!("{value}Z")
    }
}

fn normalize_entity_url(value: &str) -> String {
    for prefix in [
        "https://graph.microsoft.com/v1.0",
        "https://graph.microsoft.com/beta",
    ] {
        if let Some(relative) = value.strip_prefix(prefix) {
            return relative.to_string();
        }
    }
    value.to_string()
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn encode_segment(value: &str) -> String {
    encode(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_mail_and_html_without_raw_markup() {
        let mail = parse_mail(
            &json!({
                "id":"m1", "subject":"Hello",
                "from":{"emailAddress":{"name":"Ada","address":"ada@example.com"}},
                "body":{"contentType":"html","content":"<p>Hello <b>world</b></p>"}
            }),
            "inbox",
        );
        assert_eq!(mail.from.name, "Ada");
        assert!(mail.body_markdown.contains("**world**"));
        assert!(!mail.body_markdown.contains("<b>"));
    }

    #[test]
    fn graph_delta_urls_become_workiq_relative_paths() {
        assert_eq!(
            normalize_entity_url(
                "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=x"
            ),
            "/me/messages/delta?$deltatoken=x"
        );
    }

    #[test]
    fn cursor_advances_next_then_delta() {
        let mut state = CacheState::default();
        assert!(!apply_cursor(&mut state, "mail", Some("next".into()), None));
        assert_eq!(state.cursors["mail"], "next");
        assert!(apply_cursor(&mut state, "mail", None, Some("delta".into())));
        assert_eq!(state.cursors["mail"], "delta");
    }
}
