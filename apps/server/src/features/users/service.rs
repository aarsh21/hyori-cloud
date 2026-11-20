use crate::{
    AppState,
    db::{begin, sql},
    error::ApiError,
    features::{auth::api::Id, users::api::*},
};
use sea_orm::{ConnectionTrait, DatabaseTransaction, DbErr, QueryResult};

impl UserIdentity {
    pub(crate) fn from_row(row: &QueryResult, id: String) -> Result<Self, DbErr> {
        Ok(Self {
            id: Id(id),
            name: row.try_get("", "name")?,
            email: row.try_get("", "email")?,
        })
    }
}

pub(crate) async fn active_identity(
    tx: &DatabaseTransaction,
    id: &str,
) -> Result<Option<UserIdentity>, DbErr> {
    tx.query_one_raw(sql(
        "SELECT name,email FROM hyori_users WHERE id=$1 AND status='active'",
        vec![id.into()],
    ))
    .await?
    .map(|row| UserIdentity::from_row(&row, id.to_owned()))
    .transpose()
}

pub(crate) async fn search(
    state: &AppState,
    session: Option<&str>,
    input: SearchUsers,
) -> Result<UserSearchResults, ApiError> {
    let query = input.query.trim();
    if query.is_empty() || query.chars().count() > 100 || query.contains('\0') {
        return Err(ApiError::invalid());
    }
    let tx = begin(&state.db).await?;
    let actor = state.auth.require_actor(&tx, session).await?;
    let id = &actor.user_id().0;
    // Across sessions and processes, with an independent budget from sign-in and share unlock.
    if let Err(error) = state
        .auth
        .rate_limit(&tx, &format!("users-search:{id}"), 240)
        .await
    {
        tx.commit().await?;
        return Err(error);
    }

    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let mut word = 0;
    let substring = query.chars().any(|c| {
        word = if c.is_alphanumeric() { word + 1 } else { 0 };
        word >= 3
    });
    // Short or punctuation-heavy queries don't have an unanchored trigram. Use two bounded
    // prefix scans instead. A custom plan turns the bound LIKE pattern into B-tree range bounds.
    tx.execute_unprepared("SET LOCAL plan_cache_mode = force_custom_plan")
        .await?;
    let (statement, pattern) = if substring {
        (
            "SELECT id,name,email FROM hyori_users WHERE status='active' AND id<>$1
             AND (lower(name) LIKE lower($2) OR email LIKE lower($2)) ORDER BY id LIMIT 10",
            format!("%{escaped}%"),
        )
    } else {
        (
            "(SELECT id,name,email FROM hyori_users WHERE status='active' AND id<>$1
              AND lower(name) COLLATE \"C\" LIKE lower($2) ORDER BY lower(name) COLLATE \"C\",id LIMIT 10)
             UNION
             (SELECT id,name,email FROM hyori_users WHERE status='active' AND id<>$1
              AND email COLLATE \"C\" LIKE lower($2) ORDER BY email COLLATE \"C\",id LIMIT 10)
             ORDER BY id LIMIT 10",
            format!("{escaped}%"),
        )
    };
    let rows = tx
        .query_all_raw(sql(statement, vec![id.clone().into(), pattern.into()]))
        .await?;
    tx.commit().await?;
    let items = rows
        .iter()
        .map(|row| UserIdentity::from_row(row, row.try_get("", "id")?))
        .collect::<Result<_, DbErr>>()?;
    Ok(UserSearchResults { items })
}
