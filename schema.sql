CREATE TABLE IF NOT EXISTS records (
    id SERIAL PRIMARY KEY,
    student_name VARCHAR(255) NOT NULL,
    parent_name VARCHAR(255) NOT NULL,
    selected_branch VARCHAR(255) NOT NULL,
    phone_number VARCHAR(50) NOT NULL,
    campaign_status VARCHAR(50) DEFAULT 'Pending',
    delivery_status VARCHAR(50) DEFAULT 'Unsent',
    parent_response VARCHAR(50) DEFAULT 'No Response',
    message_id VARCHAR(255) UNIQUE NULL,
    sent_template VARCHAR(255) NULL,
    sent_at TIMESTAMP WITH TIME ZONE NULL,
    delivered_at TIMESTAMP WITH TIME ZONE NULL,
    read_at TIMESTAMP WITH TIME ZONE NULL,
    responded_at TIMESTAMP WITH TIME ZONE NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_records_message_id ON records (message_id);

CREATE TABLE IF NOT EXISTS campaign_logs (
    id SERIAL PRIMARY KEY,
    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    template_name VARCHAR(255) NOT NULL,
    campaign_status VARCHAR(50) DEFAULT 'Pending',
    delivery_status VARCHAR(50) DEFAULT 'Unsent',
    parent_response VARCHAR(50) DEFAULT 'No Response',
    message_id VARCHAR(255) UNIQUE NULL,
    sent_at TIMESTAMP WITH TIME ZONE NULL,
    delivered_at TIMESTAMP WITH TIME ZONE NULL,
    read_at TIMESTAMP WITH TIME ZONE NULL,
    responded_at TIMESTAMP WITH TIME ZONE NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_logs_record_id ON campaign_logs (record_id);
CREATE INDEX IF NOT EXISTS idx_campaign_logs_template_name ON campaign_logs (template_name);
CREATE INDEX IF NOT EXISTS idx_campaign_logs_message_id ON campaign_logs (message_id);

CREATE TABLE IF NOT EXISTS campaign_templates (
    id SERIAL PRIMARY KEY,
    template_name VARCHAR(255) UNIQUE NOT NULL,
    template_text VARCHAR(1000) NOT NULL,
    category VARCHAR(100) DEFAULT 'MARKETING',
    media_type VARCHAR(50) DEFAULT 'none',
    media_url VARCHAR(1000) NULL,
    language VARCHAR(50) DEFAULT 'en',
    variable_names VARCHAR(500) NULL,
    is_active BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    hashed_password VARCHAR(255) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users (username);

CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    sender VARCHAR(50) NOT NULL,
    message_text TEXT NOT NULL,
    media_url VARCHAR(1000) NULL,
    message_id VARCHAR(255) UNIQUE NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_record_id ON chat_messages (record_id);

CREATE TABLE IF NOT EXISTS auto_reply_rules (
    id SERIAL PRIMARY KEY,
    keyword VARCHAR(255) UNIQUE NOT NULL,
    reply_text TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
