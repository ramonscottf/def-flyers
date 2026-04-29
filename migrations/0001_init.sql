-- DEF Flyers — initial schema
-- Migrated from dsd-flyers (Apr 27, 2026)
-- 69 schools + 10 departments seeded separately

CREATE TABLE accessibility_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flyer_id TEXT NOT NULL,
  audit_type TEXT NOT NULL,               
  score INTEGER,                          
  passed INTEGER DEFAULT 0,
  findings TEXT,                          
  audited_at INTEGER NOT NULL,
  audited_version INTEGER NOT NULL,
  FOREIGN KEY (flyer_id) REFERENCES flyers(id) ON DELETE CASCADE
);

CREATE TABLE admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,                   
  target_type TEXT NOT NULL,              
  target_id TEXT NOT NULL,
  before_state TEXT,                      
  after_state TEXT,                       
  ip_address TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,               
  flyer_id TEXT,
  user_id TEXT,                           
  session_id TEXT,                        
  referrer TEXT,
  user_agent TEXT,
  country TEXT,
  created_at INTEGER NOT NULL,
  metadata TEXT,                          
  FOREIGN KEY (flyer_id) REFERENCES flyers(id)
);

CREATE TABLE contact_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_label TEXT NOT NULL,           
  source_format TEXT,                   
  imported_by TEXT NOT NULL,            
  imported_at INTEGER NOT NULL,
  total_rows INTEGER,
  imported_rows INTEGER,                
  skipped_rows INTEGER,                 
  failed_rows INTEGER,
  default_audience TEXT DEFAULT 'parents',
  default_frequency TEXT DEFAULT 'weekly',
  notes TEXT,
  raw_manifest TEXT,                    
  FOREIGN KEY (imported_by) REFERENCES users(id)
);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER,
  flyer_id TEXT,                          
  channel TEXT NOT NULL,                  
  recipient TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL,                   
  provider_message_id TEXT,
  sent_at INTEGER,
  delivered_at INTEGER,
  opened_at INTEGER,
  clicked_at INTEGER,
  error TEXT,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id),
  FOREIGN KEY (flyer_id) REFERENCES flyers(id)
);

CREATE TABLE department_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (department_id) REFERENCES departments(id),
  UNIQUE(user_id, department_id)
);

CREATE TABLE departments (
  id TEXT PRIMARY KEY,                    
  name TEXT NOT NULL,
  description TEXT,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE flyer_departments (
  flyer_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  PRIMARY KEY (flyer_id, department_id),
  FOREIGN KEY (flyer_id) REFERENCES flyers(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE flyer_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flyer_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,                 
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  change_note TEXT,
  FOREIGN KEY (flyer_id) REFERENCES flyers(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE TABLE flyer_schools (
  flyer_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  PRIMARY KEY (flyer_id, school_id),
  FOREIGN KEY (flyer_id) REFERENCES flyers(id) ON DELETE CASCADE,
  FOREIGN KEY (school_id) REFERENCES schools(id)
);

CREATE TABLE flyers (
  id TEXT PRIMARY KEY,                    
  slug TEXT NOT NULL UNIQUE,              
  title TEXT NOT NULL,
  summary TEXT NOT NULL,                  
  body_html TEXT NOT NULL,                
  body_plain TEXT NOT NULL,               
  reading_level REAL,                     
  word_count INTEGER,

  
  audience TEXT NOT NULL,                 
  scope TEXT NOT NULL,                    

  
  category TEXT NOT NULL,                 
  tags TEXT,                              

  
  status TEXT NOT NULL DEFAULT 'draft',   
  published_at INTEGER,                   
  expires_at INTEGER NOT NULL,            
  event_start_at INTEGER,                 
  event_end_at INTEGER,
  event_location TEXT,

  
  image_r2_key TEXT,                      
  image_alt_text TEXT,                    
  image_width INTEGER,
  image_height INTEGER,

  
  pdf_r2_key TEXT,
  pdf_a11y_score INTEGER,                 
  pdf_a11y_passed INTEGER DEFAULT 0,      
  pdf_a11y_report TEXT,                   

  
  submitted_by TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  rejected_reason TEXT,

  
  search_vector_id TEXT,                  

  
  updated_at INTEGER NOT NULL,
  version INTEGER DEFAULT 1,

  FOREIGN KEY (submitted_by) REFERENCES users(id),
  FOREIGN KEY (approved_by) REFERENCES users(id)
);

CREATE TABLE magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  ip_address TEXT
);

CREATE TABLE school_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',    
  created_at INTEGER NOT NULL,
  created_by TEXT,                        
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (school_id) REFERENCES schools(id),
  UNIQUE(user_id, school_id)
);

CREATE TABLE schools (
  id TEXT PRIMARY KEY,                    
  name TEXT NOT NULL,                     
  short_name TEXT,                        
  level TEXT NOT NULL,                    
  address TEXT,
  phone TEXT,
  website TEXT,
  active INTEGER DEFAULT 1,
  display_order INTEGER DEFAULT 100,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                    
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip_address TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,                           
  email TEXT NOT NULL,                    
  audience TEXT NOT NULL,                 

  
  school_ids TEXT,                        
  department_ids TEXT,                    
  categories TEXT,                        

  
  digest_frequency TEXT NOT NULL DEFAULT 'weekly', 
  delivery TEXT NOT NULL DEFAULT 'email', 
  phone TEXT,                             

  
  active INTEGER DEFAULT 1,
  verified INTEGER DEFAULT 0,
  verification_token TEXT,
  unsubscribe_token TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  last_opened_at INTEGER, source TEXT DEFAULT 'self_signup', import_id INTEGER, student_grades TEXT, parent_first_name TEXT, parent_last_name TEXT,

  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,                    
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  auth_provider TEXT,                     
  provider_user_id TEXT,                  
  is_employee INTEGER DEFAULT 0,          
  is_district_admin INTEGER DEFAULT 0,    
  created_at INTEGER NOT NULL,            
  last_login INTEGER,
  last_active INTEGER
);

CREATE INDEX idx_a11y_audits_flyer ON accessibility_audits(flyer_id);

CREATE INDEX idx_audit_created ON admin_audit_log(created_at);

CREATE INDEX idx_audit_target ON admin_audit_log(target_type, target_id);

CREATE INDEX idx_audit_user ON admin_audit_log(user_id);

CREATE INDEX idx_contact_imports_at ON contact_imports(imported_at);

CREATE INDEX idx_deliveries_flyer ON deliveries(flyer_id);

CREATE INDEX idx_deliveries_sent ON deliveries(sent_at);

CREATE INDEX idx_deliveries_status ON deliveries(status);

CREATE INDEX idx_deliveries_sub ON deliveries(subscription_id);

CREATE INDEX idx_events_created ON analytics_events(created_at);

CREATE INDEX idx_events_flyer ON analytics_events(flyer_id);

CREATE INDEX idx_events_type ON analytics_events(event_type);

CREATE INDEX idx_flyer_departments_dept ON flyer_departments(department_id);

CREATE INDEX idx_flyer_revisions_flyer ON flyer_revisions(flyer_id);

CREATE INDEX idx_flyer_schools_school ON flyer_schools(school_id);

CREATE INDEX idx_flyers_audience ON flyers(audience);

CREATE INDEX idx_flyers_category ON flyers(category);

CREATE INDEX idx_flyers_event_start ON flyers(event_start_at);

CREATE INDEX idx_flyers_expires ON flyers(expires_at);

CREATE INDEX idx_flyers_published ON flyers(published_at);

CREATE INDEX idx_flyers_slug ON flyers(slug);

CREATE INDEX idx_flyers_status ON flyers(status);

CREATE INDEX idx_magic_links_email ON magic_links(email);

CREATE INDEX idx_magic_links_expires ON magic_links(expires_at);

CREATE INDEX idx_school_admins_school ON school_admins(school_id);

CREATE INDEX idx_school_admins_user ON school_admins(user_id);

CREATE INDEX idx_schools_active ON schools(active);

CREATE INDEX idx_schools_level ON schools(level);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE INDEX idx_subs_active ON subscriptions(active);

CREATE INDEX idx_subs_audience ON subscriptions(audience);

CREATE INDEX idx_subs_email ON subscriptions(email);

CREATE INDEX idx_subs_grades ON subscriptions(student_grades);

CREATE INDEX idx_subs_import ON subscriptions(import_id);

CREATE INDEX idx_subs_source ON subscriptions(source);

CREATE INDEX idx_subs_unsub ON subscriptions(unsubscribe_token);

CREATE INDEX idx_users_email ON users(email);

CREATE INDEX idx_users_provider ON users(auth_provider, provider_user_id);
