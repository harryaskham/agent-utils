#![forbid(unsafe_code)]

pub mod cache;
pub mod config;
pub mod feed;
pub mod markdown;
pub mod model;
pub mod slack;
pub mod ui;

pub use cache::CacheStore;
pub use config::{Config, ThemeName};
pub use feed::{Feed, FeedEntry, FeedTarget};
pub use model::CacheState;
pub use slack::{demo_state, SlackService};
