use crate::{
    auth::digest,
    db::{DomainResult, sql},
    error::ApiError,
};
use sea_orm::{ConnectionTrait, DatabaseTransaction};

/// Bounded DB-only preparation. Account activity is already fenced before any row is reclaimed.
pub(crate) async fn prepare(tx: &DatabaseTransaction, user: &str) -> DomainResult<()> {
    crate::features::media::cleanup::prepare_purge(tx, user).await?;
    crate::features::editors::cleanup::purge(tx, user).await?;
    let account = tx
        .query_one_raw(sql(
            "SELECT email FROM hyori_users WHERE id=$1 AND status IN ('deleting','deleted')",
            vec![user.into()],
        ))
        .await?
        .ok_or_else(ApiError::denied)?;
    let email: String = account.try_get("", "email")?;
    let uploads = tx.query_all_raw(sql(
        "SELECT id,owner_id,state FROM hyori_uploads u WHERE
         (owner_id=$1 AND NOT EXISTS(SELECT 1 FROM hyori_account_purge_uploads p WHERE p.user_id=$1 AND p.upload_id=u.id)) OR uploader_id=$1
         ORDER BY id LIMIT 256 FOR UPDATE SKIP LOCKED",vec![user.into()])).await?;
    let mut abort = Vec::<String>::new();
    let mut preserve = Vec::<String>::new();
    for row in uploads {
        let id = row.try_get("", "id")?;
        if row.try_get::<String>("", "owner_id")? != user
            && row.try_get::<String>("", "state")? == "complete"
        {
            preserve.push(id);
        } else {
            abort.push(id);
        }
    }
    if !abort.is_empty() {
        let ids = serde_json::json!(abort);
        tx.execute_raw(sql("UPDATE hyori_users u SET reserved_bytes=u.reserved_bytes-r.bytes FROM
            (SELECT owner_id,sum(size)::bigint AS bytes FROM hyori_uploads WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND reservation_held GROUP BY owner_id) r WHERE u.id=r.owner_id",vec![ids.clone().into()])).await?;
        tx.execute_raw(sql("INSERT INTO hyori_account_purge_uploads(user_id,upload_id) SELECT $1,id FROM jsonb_array_elements_text($2::jsonb) ids(id) ON CONFLICT DO NOTHING",vec![user.into(),ids.clone().into()])).await?;
        // Fencing clears publication and cleanup leases. A previously claimed 'complete' cleanup
        // cannot certify this newly aborted key without actually deleting its original.
        tx.execute_raw(sql("UPDATE hyori_uploads SET state='aborted',reservation_held=false,purged=true,purge_checked_at=NULL,
            name='',mime_type='',size=0,parent_id=NULL,uploader_id=NULL,grant_digests='[]',replace_id=NULL,replace_revision=NULL,file_id=NULL,result=NULL,
            lease_token=NULL,lease_until=NULL,cleanup_token=NULL,cleanup_until=NULL,cleanup_due=now()
            WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))",vec![ids.into()])).await?;
    }
    if !preserve.is_empty() {
        // A committed contribution is another account's data. Never turn it into a delete marker.
        tx.execute_raw(sql("UPDATE hyori_uploads SET uploader_id=NULL,grant_digests='[]' WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))",vec![serde_json::json!(preserve).into()])).await?;
    }
    tx.execute_raw(sql("DELETE FROM hyori_upload_parts WHERE (upload_id,part_number) IN (
        SELECT part.upload_id,part.part_number FROM hyori_upload_parts part JOIN hyori_account_purge_uploads p ON p.upload_id=part.upload_id WHERE p.user_id=$1 ORDER BY part.upload_id,part.part_number LIMIT 256)",vec![user.into()])).await?;
    tx.execute_raw(sql("DELETE FROM hyori_sessions WHERE id IN (SELECT id FROM hyori_sessions WHERE user_id=$1 ORDER BY id LIMIT 256)",vec![user.into()])).await?;
    tx.execute_raw(sql(
        "DELETE FROM hyori_credentials WHERE user_id=$1",
        vec![user.into()],
    ))
    .await?;
    tx.execute_raw(sql("DELETE FROM hyori_invites WHERE token_digest IN (SELECT token_digest FROM hyori_invites WHERE issuer_id=$1 OR email=$2 ORDER BY token_digest LIMIT 256)",vec![user.into(),email.clone().into()])).await?;
    tx.execute_raw(sql(
        "DELETE FROM hyori_rate_limits WHERE key_digest=$1",
        vec![digest(&format!("login:{email}")).into()],
    ))
    .await?;
    tx.execute_raw(sql("DELETE FROM hyori_grants WHERE token_digest IN (SELECT g.token_digest FROM hyori_grants g JOIN hyori_shares s ON s.id=g.share_id WHERE s.issuer_id=$1 OR s.recipient_id=$1 ORDER BY g.token_digest LIMIT 256)",vec![user.into()])).await?;
    tx.execute_raw(sql("DELETE FROM hyori_shares WHERE id IN (SELECT s.id FROM hyori_shares s WHERE (s.issuer_id=$1 OR s.recipient_id=$1) AND NOT EXISTS(SELECT 1 FROM hyori_grants g WHERE g.share_id=s.id) ORDER BY s.id LIMIT 256)",vec![user.into()])).await?;
    tx.execute_raw(sql(
        "DELETE FROM hyori_photo_sources WHERE user_id=$1",
        vec![user.into()],
    ))
    .await?;
    tx.execute_raw(sql("DELETE FROM hyori_photo_album_items WHERE (album_id,file_id) IN (
        SELECT a.album_id,a.file_id FROM hyori_photo_album_items a WHERE EXISTS(SELECT 1 FROM hyori_photo_albums p WHERE p.id=a.album_id AND p.owner_id=$1)
        OR EXISTS(SELECT 1 FROM hyori_items i WHERE i.id=a.file_id AND i.owner_id=$1) ORDER BY a.album_id,a.file_id LIMIT 256)",vec![user.into()])).await?;
    tx.execute_raw(sql("DELETE FROM hyori_photo_albums WHERE id IN (SELECT a.id FROM hyori_photo_albums a WHERE a.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM hyori_photo_album_items i WHERE i.album_id=a.id) ORDER BY a.id LIMIT 256)",vec![user.into()])).await?;
    tx.execute_raw(sql("DELETE FROM hyori_versions WHERE id IN (SELECT id FROM hyori_versions WHERE owner_id=$1 ORDER BY id LIMIT 256)",vec![user.into()])).await?;
    tx.execute_raw(sql("UPDATE hyori_items SET uploaded_by=NULL WHERE id IN (SELECT id FROM hyori_items WHERE uploaded_by=$1 ORDER BY id LIMIT 256)",vec![user.into()])).await?;
    // Leaf-first, including trash. No ordinary 1,000-descendant mutation limit or unbounded FK cascade.
    tx.execute_raw(sql(
        "DELETE FROM hyori_items WHERE id IN (SELECT i.id FROM hyori_items i WHERE i.owner_id=$1
        AND NOT EXISTS(SELECT 1 FROM hyori_items child WHERE child.parent_id=i.id)
        AND NOT EXISTS(SELECT 1 FROM hyori_versions v WHERE v.file_id=i.id)
        AND NOT EXISTS(SELECT 1 FROM hyori_shares s WHERE s.item_id=i.id)
        AND NOT EXISTS(SELECT 1 FROM hyori_photo_album_items a WHERE a.file_id=i.id)
        ORDER BY i.id LIMIT 256)",
        vec![user.into()],
    ))
    .await?;
    Ok(())
}

pub(crate) async fn pending(tx: &DatabaseTransaction, user: &str) -> DomainResult<bool> {
    let row = tx.query_one_raw(sql("SELECT
        EXISTS(SELECT 1 FROM hyori_items WHERE owner_id=$1 OR uploaded_by=$1) OR
        EXISTS(SELECT 1 FROM hyori_versions WHERE owner_id=$1) OR
        EXISTS(SELECT 1 FROM hyori_sessions WHERE user_id=$1) OR
        EXISTS(SELECT 1 FROM hyori_credentials WHERE user_id=$1) OR
        EXISTS(SELECT 1 FROM hyori_invites WHERE issuer_id=$1 OR email=(SELECT email FROM hyori_users WHERE id=$1)) OR
        EXISTS(SELECT 1 FROM hyori_shares WHERE issuer_id=$1 OR recipient_id=$1) OR
        EXISTS(SELECT 1 FROM hyori_photo_sources WHERE user_id=$1) OR
        EXISTS(SELECT 1 FROM hyori_photo_albums WHERE owner_id=$1) OR
        EXISTS(SELECT 1 FROM hyori_uploads u WHERE uploader_id=$1 OR
            (owner_id=$1 AND NOT EXISTS(SELECT 1 FROM hyori_account_purge_uploads p WHERE p.user_id=$1 AND p.upload_id=u.id))) OR
        EXISTS(SELECT 1 FROM hyori_account_purge_uploads p JOIN hyori_upload_parts part ON part.upload_id=p.upload_id WHERE p.user_id=$1) OR
        EXISTS(SELECT 1 FROM hyori_account_purge_uploads p JOIN hyori_uploads u ON u.id=p.upload_id JOIN hyori_account_purges a ON a.user_id=p.user_id
            WHERE p.user_id=$1 AND (u.state<>'aborted' OR u.purge_checked_at IS NULL OR u.purge_checked_at<a.created_at)) AS pending",vec![user.into()])).await?.ok_or_else(ApiError::unavailable)?;
    Ok(row.try_get::<bool>("", "pending")?
        || crate::features::media::cleanup::purge_pending(tx, user).await?
        || crate::features::editors::cleanup::purge_pending(tx, user).await?)
}
