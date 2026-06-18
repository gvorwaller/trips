-- Text documents (td-072807): a pasted-text alternative to uploaded files.
-- High-friction on phone to create a file just to attach an email body, so allow
-- saving text directly as a "document" row that renders inline (searchable,
-- editable, no Spaces object).
--
-- A text doc has no Spaces object, so object_key becomes optional and a shape
-- CHECK ties each kind to the field it actually uses: files carry an object_key,
-- text docs carry text_content. mime_type stays NOT NULL ('text/plain' for text);
-- size_bytes stays the existing >0 / <=30MB CHECK (byte length of the text).
ALTER TABLE attachments
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'text')),
    ADD COLUMN text_content TEXT,
    ALTER COLUMN object_key DROP NOT NULL,
    ADD CONSTRAINT attachments_kind_shape CHECK (
        (kind = 'file' AND object_key IS NOT NULL) OR
        (kind = 'text' AND text_content IS NOT NULL)
    );
