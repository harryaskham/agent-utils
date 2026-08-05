pub mod cache;
pub mod client;
pub mod config;
pub mod daemon;
pub mod model;
pub mod query;
pub mod service;
pub mod ui;
pub mod workiq;

pub use cache::CacheStore;
pub use config::Config;
pub use model::CacheState;

#[must_use]
pub fn demo_state() -> CacheState {
    use model::{Account, Address, CalendarEvent, Channel, Chat, ChatMessage, MailMessage, Team};
    let mut state = CacheState {
        account: Account {
            id: "user-1".into(),
            display_name: "Example User".into(),
            mail: "user@example.com".into(),
            user_principal_name: "user@example.com".into(),
        },
        mail: vec![
            MailMessage {
                id: "mail-1".into(),
                subject: "Quarterly plan review".into(),
                from: Address {
                    name: "Ada Lovelace".into(),
                    address: "ada@example.com".into(),
                },
                received_at: "2026-08-04T15:30:00Z".into(),
                body_preview: "Please review the attached plan before tomorrow.".into(),
                body_markdown: "Please review the **attached plan** before tomorrow.".into(),
                is_read: false,
                web_link: "https://outlook.office.com/mail/id/mail-1".into(),
                ..MailMessage::default()
            },
            MailMessage {
                id: "mail-2".into(),
                subject: "Build completed".into(),
                from: Address {
                    name: "Release Bot".into(),
                    address: "release@example.com".into(),
                },
                received_at: "2026-08-04T14:10:00Z".into(),
                body_preview: "The nightly build completed successfully.".into(),
                is_read: true,
                ..MailMessage::default()
            },
        ],
        events: vec![CalendarEvent {
            id: "event-1".into(),
            subject: "Architecture review".into(),
            organizer: Address {
                name: "Grace Hopper".into(),
                address: "grace@example.com".into(),
            },
            start: "2026-08-05T10:00:00Z".into(),
            end: "2026-08-05T10:30:00Z".into(),
            timezone: "UTC".into(),
            location: "Teams".into(),
            body_preview: "Review the daemon/client design.".into(),
            is_online_meeting: true,
            join_url: "https://teams.microsoft.com/l/meetup-join/example".into(),
            ..CalendarEvent::default()
        }],
        chats: vec![Chat {
            id: "chat-1".into(),
            topic: "Annum launch".into(),
            chat_type: "group".into(),
            updated_at: "2026-08-04T16:00:00Z".into(),
            web_url: "https://teams.microsoft.com/l/chat/example".into(),
            members: vec![Address {
                name: "Ada Lovelace".into(),
                address: "ada@example.com".into(),
            }],
        }],
        teams: vec![Team {
            id: "team-1".into(),
            display_name: "Engineering".into(),
            description: "Engineering team".into(),
            ..Team::default()
        }],
        ..CacheState::default()
    };
    state.channels.insert(
        "team-1".into(),
        vec![Channel {
            id: "channel-1".into(),
            team_id: "team-1".into(),
            display_name: "General".into(),
            description: "Engineering announcements".into(),
            web_url: "https://teams.microsoft.com/l/channel/example".into(),
            ..Channel::default()
        }],
    );
    state.channel_messages.insert(
        "channel:team-1:channel-1".into(),
        vec![ChatMessage {
            id: "channel-message-1".into(),
            created_at: "2026-08-04T16:05:00Z".into(),
            from: Address {
                name: "Grace Hopper".into(),
                address: "grace@example.com".into(),
            },
            body_markdown: "The release checklist is posted.".into(),
            ..ChatMessage::default()
        }],
    );
    state.chat_messages.insert(
        "chat-1".into(),
        vec![ChatMessage {
            id: "chat-message-1".into(),
            created_at: "2026-08-04T16:00:00Z".into(),
            from: Address {
                name: "Ada Lovelace".into(),
                address: "ada@example.com".into(),
            },
            body_markdown: "The deterministic cache is ready for review.".into(),
            ..ChatMessage::default()
        }],
    );
    state.saved_at = Some(CacheState::now());
    state.normalize();
    state
}
