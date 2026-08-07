use crate::model::CostState;

pub type ClientOptions = remote_cli::ClientOptions<CostState>;
pub type ClientSubscription = remote_cli::ClientSubscription<CostState>;
pub type ClientUpdate = remote_cli::ClientUpdate<CostState>;
pub use remote_cli::ClientHealth;
