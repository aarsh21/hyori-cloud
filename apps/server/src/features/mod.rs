pub mod auth {
    pub mod api;
    pub mod password_api;
    pub mod passwords;
    pub mod service;
}
pub mod files {
    pub mod api;
    pub(crate) mod db;
    pub(crate) mod deletion;
    pub(crate) mod policy;
    pub(crate) mod preview;
    pub(crate) mod service;
    pub(crate) mod sorting;
    pub(crate) mod thumbnails;
    pub use deletion::purge_expired_trash;
    pub use service::{ContentDescriptor, read_content};
}
pub mod editors {
    pub mod api;
    pub mod cleanup;
    pub(crate) mod formats;
    pub(crate) mod history;
    pub(crate) mod http;
    pub(crate) mod ingest;
    pub(crate) mod policy;
    pub(crate) mod retention;
    pub(crate) mod service;
}
pub mod uploads {
    pub(crate) mod admission;
    pub mod api;
    pub mod cleanup;
    pub(crate) mod db;
    pub(crate) mod http;
    pub(crate) mod policy;
    pub(crate) mod service;
}
pub mod shares {
    pub mod api;
    pub mod capability;
    pub(crate) mod db;
    pub(crate) mod service;
}
pub mod users {
    pub mod api;
    pub(crate) mod service;
}
pub mod admin {
    pub mod api;
    pub mod purge;
    pub(crate) mod purge_db;
    pub(crate) mod service;
}
pub mod media {
    pub mod api;
    pub(crate) mod capture;
    pub mod cleanup;
    pub(crate) mod http;
    pub mod jobs;
    pub(crate) mod service;
    pub(crate) mod upgrades;
}
pub mod photos {
    pub mod api;
    pub(crate) mod db;
    pub(crate) mod service;
}
pub mod notes {
    pub mod api;
    pub(crate) mod http;
    pub(crate) mod service;
}
pub mod collaboration {
    pub mod api;
    pub(crate) mod service;
}
