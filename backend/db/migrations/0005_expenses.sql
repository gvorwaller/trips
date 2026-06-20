CREATE TABLE expenses (
    id            SERIAL PRIMARY KEY,
    trip_id       INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    expense_date  DATE,
    description   TEXT NOT NULL,
    amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
    category      TEXT NOT NULL DEFAULT 'other'
                    CHECK (category IN ('lodging','food','transport','activities','other')),
    attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
    notes         TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX expenses_trip_idx ON expenses(trip_id, sort_order);
