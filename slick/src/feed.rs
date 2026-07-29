//! Live feed: one deduplicated line per arriving item, released at a steady pace.
//!
//! Slack refreshes arrive as bursts (one poll can return a hundred items). The
//! feed keeps its own ordered log so the UI can show a stream instead of a
//! dump: new items are queued and released on a cadence derived from the
//! refresh interval, and an item that changes updates its existing line rather
//! than appending a duplicate.

use crate::model::{CacheState, ConversationKind, Notification, SlackFile};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// What an entry points at when opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FeedTarget {
    /// A conversation, optionally at a specific thread root.
    Conversation {
        /// Conversation id.
        id: String,
        /// Conversation kind, so the UI can pick the right page.
        kind: ConversationKind,
    },
    /// A file or canvas.
    File {
        /// File id.
        id: String,
    },
}

/// One rendered feed line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedEntry {
    /// Stable identity used for dedupe-on-update.
    pub key: String,
    /// Source label (conversation or file container).
    pub source: String,
    /// Short time label.
    pub time: String,
    /// One-line summary.
    pub summary: String,
    /// Whether the item is a mention.
    pub mention: bool,
    /// Whether the item is unread.
    pub unread: bool,
    /// Number of times this entry has been updated in place.
    pub revision: u32,
    /// What to open on click/Enter.
    pub target: FeedTarget,
}

/// Ordered, deduplicated feed with paced release of buffered items.
#[derive(Debug)]
pub struct Feed {
    entries: Vec<FeedEntry>,
    index: HashMap<String, usize>,
    pending: Vec<FeedEntry>,
    next_release: Option<Instant>,
    interval: Duration,
    capacity: usize,
    /// Newly arrived mentions/unread DMs not yet announced.
    ///
    /// Only genuinely NEW lines count: an edited or re-delivered item updates
    /// its existing line, and re-announcing that would cry wolf.
    pending_alerts: usize,
}

impl Default for Feed {
    fn default() -> Self {
        Self::new(Duration::from_secs(60), 500)
    }
}

impl Feed {
    /// Feed pacing one burst evenly across `window`, retaining `capacity` lines.
    #[must_use]
    pub fn new(window: Duration, capacity: usize) -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
            pending: Vec::new(),
            next_release: None,
            interval: window,
            capacity,
            pending_alerts: 0,
        }
    }

    /// Take the count of unannounced new mentions/unread DMs, clearing it.
    ///
    /// Coalescing is the caller's job: a refresh can release a whole burst at
    /// once and that must be one announcement, not fifty.
    pub fn take_alerts(&mut self) -> usize {
        std::mem::take(&mut self.pending_alerts)
    }

    /// Visible entries, newest first.
    #[must_use]
    pub fn entries(&self) -> &[FeedEntry] {
        &self.entries
    }

    /// Items still queued for paced release.
    #[must_use]
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Ingest the current cache snapshot, queueing anything new or changed.
    ///
    /// Returns the number of items queued. Existing lines whose content changed
    /// are updated in place immediately (an edit should not wait behind a
    /// backlog), while genuinely new lines are paced.
    pub fn ingest(&mut self, state: &CacheState, now: Instant) -> usize {
        let mut queued = 0;
        for candidate in Self::candidates(state) {
            match self.index.get(&candidate.key).copied() {
                Some(position) => {
                    let existing = &mut self.entries[position];
                    if existing.summary != candidate.summary
                        || existing.unread != candidate.unread
                        || existing.time != candidate.time
                    {
                        let revision = existing.revision.saturating_add(1);
                        *existing = FeedEntry {
                            revision,
                            ..candidate
                        };
                    }
                }
                None => {
                    if let Some(slot) = self
                        .pending
                        .iter_mut()
                        .find(|pending| pending.key == candidate.key)
                    {
                        *slot = candidate;
                    } else {
                        if candidate.mention || candidate.unread {
                            self.pending_alerts = self.pending_alerts.saturating_add(1);
                        }
                        self.pending.push(candidate);
                        queued += 1;
                    }
                }
            }
        }
        if self.next_release.is_none() && !self.pending.is_empty() {
            self.next_release = Some(now);
        }
        queued
    }

    /// Release any items whose paced slot has arrived. Returns released count.
    pub fn tick(&mut self, now: Instant) -> usize {
        let mut released = 0;
        while let Some(due) = self.next_release {
            if now < due || self.pending.is_empty() {
                break;
            }
            let entry = self.pending.remove(0);
            self.index.insert(entry.key.clone(), self.entries.len());
            self.entries.push(entry);
            released += 1;
            self.next_release = if self.pending.is_empty() {
                None
            } else {
                Some(due + self.slot_delay())
            };
        }
        if released > 0 {
            self.entries
                .sort_by(|left, right| right.time.cmp(&left.time));
            if self.entries.len() > self.capacity {
                let excess = self.entries.len() - self.capacity;
                self.entries.drain(self.capacity..);
                let _ = excess;
            }
            self.reindex();
        }
        released
    }

    /// Delay between paced releases: one burst spread across the window, with a
    /// floor so a huge batch still drains promptly.
    fn slot_delay(&self) -> Duration {
        let count = u32::try_from(self.pending.len().max(1)).unwrap_or(u32::MAX);
        let spread = self.interval / count.max(1);
        spread.max(Duration::from_millis(40))
    }

    fn reindex(&mut self) {
        self.index = self
            .entries
            .iter()
            .enumerate()
            .map(|(position, entry)| (entry.key.clone(), position))
            .collect();
    }

    fn candidates(state: &CacheState) -> Vec<FeedEntry> {
        let mut items: Vec<FeedEntry> = state
            .notifications
            .iter()
            .map(Self::from_notification)
            .collect();
        items.extend(state.files.iter().map(Self::from_file));
        items.sort_by(|left, right| right.time.cmp(&left.time));
        items
    }

    fn from_notification(notification: &Notification) -> FeedEntry {
        FeedEntry {
            key: format!(
                "msg:{}:{}",
                notification.conversation_id, notification.message.ts
            ),
            source: notification.conversation_name.clone(),
            time: notification.message.timestamp.clone(),
            summary: crate::markdown::preview(&notification.message.text, 160),
            mention: notification.mention,
            unread: notification.unread,
            revision: 0,
            target: FeedTarget::Conversation {
                id: notification.conversation_id.clone(),
                kind: notification.kind,
            },
        }
    }

    fn from_file(file: &SlackFile) -> FeedEntry {
        FeedEntry {
            key: format!("file:{}", file.id),
            source: file.file_type.clone(),
            time: file.updated_at.clone(),
            summary: format!("{} · {}", file.title, file.author),
            mention: false,
            unread: false,
            revision: 0,
            target: FeedTarget::File {
                id: file.id.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Message;

    fn state_with(messages: &[(&str, &str, &str)]) -> CacheState {
        let notifications = messages
            .iter()
            .map(|(conversation, ts, text)| Notification {
                key: format!("{conversation}:{ts}"),
                conversation_id: (*conversation).to_string(),
                conversation_name: (*conversation).to_string(),
                kind: ConversationKind::Channel,
                message: Message {
                    ts: (*ts).to_string(),
                    timestamp: format!("2026-07-28T10:00:{ts}Z"),
                    text: (*text).to_string(),
                    ..Message::default()
                },
                unread: true,
                mention: false,
            })
            .collect();
        CacheState {
            notifications,
            ..CacheState::default()
        }
    }

    #[test]
    fn new_items_are_paced_not_dumped() {
        let start = Instant::now();
        let mut feed = Feed::new(Duration::from_secs(60), 100);
        let state = state_with(&[
            ("c1", "01", "one"),
            ("c1", "02", "two"),
            ("c1", "03", "three"),
        ]);
        assert_eq!(feed.ingest(&state, start), 3);
        assert!(feed.entries().is_empty(), "nothing renders before a tick");

        assert_eq!(feed.tick(start), 1, "one line per paced slot");
        assert_eq!(feed.entries().len(), 1);
        assert_eq!(feed.pending_len(), 2);

        assert_eq!(feed.tick(start), 0, "the next slot is not due yet");
        assert_eq!(feed.tick(start + Duration::from_secs(30)), 1);
        assert_eq!(feed.entries().len(), 2);
    }

    #[test]
    fn updated_items_replace_their_line_instead_of_appending() {
        let start = Instant::now();
        let mut feed = Feed::new(Duration::from_millis(0), 100);
        let state = state_with(&[("c1", "01", "first draft")]);
        feed.ingest(&state, start);
        feed.tick(start);
        assert_eq!(feed.entries().len(), 1);
        assert_eq!(feed.entries()[0].revision, 0);

        let edited = state_with(&[("c1", "01", "edited text")]);
        assert_eq!(feed.ingest(&edited, start), 0, "no new line is queued");
        assert_eq!(feed.entries().len(), 1, "the line is updated in place");
        assert_eq!(feed.entries()[0].revision, 1);
        assert!(feed.entries()[0].summary.contains("edited"));
    }

    #[test]
    fn alerts_count_new_arrivals_once_and_ignore_edits() {
        let start = Instant::now();
        let mut feed = Feed::new(Duration::from_secs(60), 100);
        let state = state_with(&[("c1", "01", "one"), ("c1", "02", "two")]);
        feed.ingest(&state, start);
        // Two genuinely new unread items.
        assert_eq!(feed.take_alerts(), 2);
        // Draining clears: the same arrivals must not announce twice.
        assert_eq!(feed.take_alerts(), 0);

        // Re-ingesting the same items is not a new arrival.
        feed.ingest(&state, start);
        assert_eq!(feed.take_alerts(), 0);

        // An edit updates in place and must not cry wolf.
        let edited = state_with(&[("c1", "01", "one edited"), ("c1", "02", "two")]);
        feed.tick(start);
        feed.ingest(&edited, start);
        assert_eq!(feed.take_alerts(), 0, "an edit is not a new arrival");
    }

    #[test]
    fn repeated_ingests_of_the_same_item_do_not_duplicate_pending_lines() {
        let start = Instant::now();
        let mut feed = Feed::new(Duration::from_secs(60), 100);
        let state = state_with(&[("c1", "01", "one")]);
        assert_eq!(feed.ingest(&state, start), 1);
        assert_eq!(feed.ingest(&state, start), 0);
        assert_eq!(feed.pending_len(), 1);
    }
}
