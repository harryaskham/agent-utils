#![forbid(unsafe_code)]

pub mod config;
pub mod error;
pub mod model;
pub mod service;
pub mod speech;
pub mod store;
pub mod transport;
pub use error::{Error, Result};

pub fn terminal_text(value: &str) -> String {
    value
        .chars()
        .flat_map(|c| {
            if c.is_control() {
                c.escape_default().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect()
}
