use crate::model::CacheState;

pub type ClientOptions = remote_cli::ClientOptions<CacheState>;
pub type ClientSubscription = remote_cli::ClientSubscription<CacheState>;
pub type ClientUpdate = remote_cli::ClientUpdate<CacheState>;
pub use remote_cli::ClientHealth;
