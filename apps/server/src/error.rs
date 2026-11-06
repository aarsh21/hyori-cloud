use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

crate::wire_enum!(ErrorCode {
    AuthRequired => "auth.required", InvalidCredentials => "auth.invalidCredentials",
    SetupDenied => "auth.setupDenied", RateLimited => "auth.rateLimited",
    AccessDenied => "access.denied", InvalidInput => "input.invalid",
    NotFound => "resource.notFound", Conflict => "resource.conflict",
    QuotaExceeded => "storage.quotaExceeded", Unavailable => "service.unavailable"
});
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}
impl ApiError {
    pub fn new(code: ErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn invalid() -> Self {
        Self::new(ErrorCode::InvalidInput, "Invalid request input")
    }
    pub fn unavailable() -> Self {
        Self::new(ErrorCode::Unavailable, "Service temporarily unavailable")
    }
    pub fn denied() -> Self {
        Self::new(ErrorCode::AccessDenied, "Access denied")
    }
    pub fn required() -> Self {
        Self::new(ErrorCode::AuthRequired, "Sign in to continue")
    }
    pub fn credentials() -> Self {
        Self::new(
            ErrorCode::InvalidCredentials,
            "Email or password is incorrect",
        )
    }
    pub fn limited() -> Self {
        Self::new(ErrorCode::RateLimited, "Too many attempts. Try again later")
    }
    pub fn not_found() -> Self {
        Self::new(ErrorCode::NotFound, "Operation or resource not found")
    }
    pub fn conflict() -> Self {
        Self::new(
            ErrorCode::Conflict,
            "Resource conflicts with existing state",
        )
    }
    pub fn status(&self) -> StatusCode {
        match self.code {
            ErrorCode::AuthRequired | ErrorCode::InvalidCredentials => StatusCode::UNAUTHORIZED,
            ErrorCode::AccessDenied | ErrorCode::SetupDenied => StatusCode::FORBIDDEN,
            ErrorCode::InvalidInput => StatusCode::BAD_REQUEST,
            ErrorCode::NotFound => StatusCode::NOT_FOUND,
            ErrorCode::Conflict | ErrorCode::QuotaExceeded => StatusCode::CONFLICT,
            ErrorCode::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            ErrorCode::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}
pub(crate) fn database_sqlstate(error: &sea_orm::DbErr) -> Option<std::borrow::Cow<'_, str>> {
    use sea_orm::{DbErr, RuntimeErr};
    let (DbErr::Exec(RuntimeErr::SqlxError(error)) | DbErr::Query(RuntimeErr::SqlxError(error))) =
        error
    else {
        return None;
    };
    error
        .as_database_error()
        .and_then(|error| error.code())
        .filter(|code| {
            code.len() == 5
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        })
}
impl From<sea_orm::DbErr> for ApiError {
    fn from(error: sea_orm::DbErr) -> Self {
        // SQL text, messages, constraints and values can contain private data; log only SQLSTATE.
        let sqlstate = database_sqlstate(&error);
        tracing::error!(
            category = "database",
            sqlstate = sqlstate.as_deref().unwrap_or("none"),
            "database operation failed"
        );
        if matches!(
            error.sql_err(),
            Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
        ) {
            Self::conflict()
        } else {
            Self::unavailable()
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status(),
            Json(serde_json::json!({"ok": false, "error": self})),
        )
            .into_response()
    }
}
