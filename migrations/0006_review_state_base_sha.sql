-- Older review states lack a trusted base SHA and require a full review.
ALTER TABLE review_state ADD COLUMN base_sha TEXT;
