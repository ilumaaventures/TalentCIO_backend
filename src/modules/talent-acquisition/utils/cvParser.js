const pdf = require('pdf-parse');
const mammoth = require('mammoth');

/**
 * Basic non-AI CV Parser using Regex and Keyword matching.
 * @param {Buffer} fileBuffer - The CV file content.
 * @param {string} fileType - The MIME type (application/pdf or application/vnd.openxmlformats-officedocument.wordprocessingml.document).
 */
async function parseCV(fileBuffer, fileType) {
    let text = '';

    try {
        if (fileType === 'application/pdf') {
            const data = await pdf(fileBuffer);
            text = data.text;
        } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const data = await mammoth.extractRawText({ buffer: fileBuffer });
            text = data.value;
        } else {
            throw new Error('Unsupported file type');
        }
    } catch (error) {
        console.error('Error extracting text from CV:', error);
        throw new Error('Failed to extract text from the uploaded file.');
    }

    // --- ENTITY EXTRACTION (NON-AI) ---

    // 1. Email Extraction
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
    const emails = text.match(emailRegex) || [];
    const email = emails.length > 0 ? emails[0] : '';

    // 2. Mobile Number Extraction
    // Patterns for 10-digit numbers, international formats, etc.
    const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    const phones = text.match(phoneRegex) || [];
    const mobile = phones.length > 0 ? phones[0].trim() : '';

    // 3. Name Extraction (Heuristics)
    // Often the name is in the first 3 lines of text.
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let name = '';
    if (lines.length > 0) {
        // Find the first line that doesn't look like common metadata or contact info
        for (let i = 0; i < Math.min(5, lines.length); i++) {
            const line = lines[i];
            if (!line.includes('@') && !/\d{5,}/.test(line) && line.split(' ').length >= 2) {
                name = line;
                break;
            }
        }
    }

    // 4. Skills Extraction (Keyword Matching)
const skillsDictionary = [
  // ================== FRONTEND ==================
  'React', 'Next.js', 'Node.js', 'Express', 'JavaScript', 'JS', 'TypeScript', 'TS', 'Angular', 'Vue.js', 'Svelte',
  'HTML', 'HTML5', 'CSS', 'CSS3', 'Tailwind', 'TailwindCSS', 'SASS', 'SCSS', 'Bootstrap', 'Redux', 'Zustand', 'Context API', 'GraphQL',
  'Vite', 'Webpack', 'Babel', 'Figma', 'Adobe XD', 'UI', 'UX', 'Responsive Design', 'Material UI', 'Ant Design', 'Chakra UI',
  'Vuex', 'Pinia', 'Nuxt.js', 'Gatsby', 'Remix', 'Astro', 'Qwik', 'SolidJS', 'Lit', 'Stencil',
  'Alpine.js', 'HTMX', 'jQuery', 'Ember.js', 'Backbone.js', 'styled-components', 'Emotion',
  'Storybook', 'Axios', 'SWR', 'React Query', 'Apollo Client', 'Relay', 'Prismic', 'Contentful', 'Sanity',
  'Vuetify', 'Quasar', 'PrimeVue', 'PrimeReact', 'Semantic UI', 'Bulma', 'Foundation',
  'Less', 'Stylus', 'PostCSS', 'CSS Modules', 'Twin.macro', 'Vanilla Extract', 'Stitches',
  'SvelteKit', 'Sapper', 'Blazor', '.NET MAUI', 'Web Components', 'Micro Frontends', 'PWA',
  'Webpack Dev Server', 'ESLint', 'Prettier', 'Husky', 'lint-staged', 'Commitlint',
  'Cypress Component Testing', 'Playwright Component Testing', 'Vitest', 'Testing Library',
  'React Hook Form', 'Formik', 'Yup', 'Zod', 'React Table', 'TanStack Table', 'React Select',
  'React DnD', 'D3.js', 'Chart.js', 'Highcharts', 'ECharts', 'Three.js', 'Babylon.js',
  'SVG', 'Canvas', 'WebGL', 'WebRTC', 'WebSockets', 'Socket.io', 'Pusher',
  'Micro Frontend Architecture', 'Module Federation', 'Single-SPA', 'qiankun',
  'Polymer', 'AMP', 'Flash', 'Silverlight', 'XSLT', 'XML', 'JSON', 'YAML',
  'OpenAPI', 'Swagger', 'PostCSS Preset Env', 'CSS-in-JS', 'Panda CSS', 'StyleX',
  'Component Library', 'Headless UI', 'Radix UI', 'Shadcn UI', 'React Aria',
  'Internationalization', 'i18next', 'FormatJS', 'Globalize', 'LinguiJS',
  'Markdown', 'MDX', 'Hugo', 'Jekyll', 'Eleventy', 'VitePress', 'Docusaurus',

  // ================== BACKEND & LANGUAGES ==================
  'Python', 'Java', 'C++', 'C#', 'PHP', 'Ruby', 'Ruby on Rails', 'Golang', 'Go Language', 'Rust', 'Scala', 'Kotlin', 'Swift',
  'Spring Boot', 'Django', 'Flask', 'NestJS', 'Laravel', 'ASP.NET', 'Koa', 'Strapi', 'FastAPI', 'Microservices', 'Serverless',
  'R', 'MATLAB', 'Julia', 'Dart', 'Lua', 'Perl', 'Bash', 'Shell Scripting', 'PowerShell',
  '.NET Core', '.NET Framework', 'VB.NET', 'F#', 'Elixir', 'Erlang', 'Haskell', 'Clojure', 'Groovy',
  'Solidity', 'ABAP', 'Apex', 'COBOL', 'Fortran', 'Assembly', 'VHDL', 'Verilog',
  'Hibernate', 'Micronaut', 'Quarkus', 'Grails', 'Play Framework', 'Dropwizard',
  'Gin', 'Echo', 'Fiber', 'Rocket', 'Actix', 'Axum', 'Phoenix',
  'Symfony', 'Yii', 'CodeIgniter', 'CakePHP', 'Slim',
  'Fastify', 'Sails.js', 'Meteor', 'AdonisJS', 'LoopBack', 'Hapi.js', 'Restify',
  'FeathersJS', 'Moleculer', 'Seneca', 'Total.js',
  'gRPC', 'GraphQL Yoga', 'Apollo Server', 'Hasura', 'Prisma',
  'WordPress', 'Drupal', 'Joomla', 'Magento', 'WooCommerce', 'BigCommerce', 'Shopify',
  'Webflow', 'Squarespace', 'Wix', 'Bubble', 'OutSystems', 'Mendix', 'Appian',
  'Power Apps', 'Power Automate', 'UiPath', 'Automation Anywhere', 'Blue Prism', 'RPA',
  'ChatGPT', 'OpenAI', 'LLM', 'Prompt Engineering', 'Generative AI', 'Stable Diffusion', 'Midjourney', 'DALL-E',
  'C', 'Objective-C', 'Ada', 'ALGOL', 'PL/SQL', 'T-SQL', 'Rexx', 'JCL',
  'GraphQL Federation', 'REST', 'JSON-RPC', 'SOAP', 'CORBA', 'Thrift', 'Avro',
  'Spring Cloud', 'Spring Security', 'Spring Batch', 'Spring Integration',
  'Express Middleware', 'Passport.js', 'Helmet', 'CORS', 'Rate Limiting',
  'Dependency Injection', 'IoC Container', 'AOP', 'Event Sourcing', 'CQRS',
  'Message Queue', 'Task Queue', 'Celery', 'Bull', 'Bee-Queue', 'Sidekiq', 'Resque',
  'Background Jobs', 'Scheduled Tasks', 'Cron', 'Quartz', 'Hangfire',
  'CMS', 'Headless CMS', 'Strapi', 'Ghost', 'Contentstack', 'Kentico',

  // ================== DATABASES ==================
  'PostgreSQL', 'MongoDB', 'MySQL', 'Redis', 'Oracle', 'SQLite', 'MariaDB', 'Firebase', 'Cassandra', 'DynamoDB', 'Elasticsearch', 'Mongoose',
  'Neo4j', 'ArangoDB', 'CouchDB', 'Couchbase', 'InfluxDB', 'TimescaleDB', 'CockroachDB',
  'YugabyteDB', 'PlanetScale', 'Neon', 'Supabase', 'Firestore', 'RDS', 'Aurora',
  'BigQuery', 'Snowflake', 'Redshift', 'Databricks', 'Synapse Analytics',
  'Apache Kafka', 'RabbitMQ', 'ActiveMQ', 'ZeroMQ', 'NATS', 'Pulsar',
  'Graph Database', 'Vector Database', 'Pinecone', 'Weaviate', 'Chroma',
  'OLAP', 'OLTP', 'Columnar Database', 'Key-Value Store', 'Document Store',
  'Database Design', 'ERD', 'Normalization', 'Indexing', 'Query Optimization',
  'Database Migration', 'Seed Data', 'Backup & Recovery', 'Replication', 'Sharding',
  'MongoDB Atlas', 'Cloud SQL', 'Bigtable', 'Cosmos DB', 'Cassandra DB',
  'Redis Cluster', 'Redis Sentinel', 'Memcached', 'Hazelcast', 'Apache Ignite',

  // ================== CLOUD & DEVOPS ==================
  'AWS', 'Azure', 'GCP', 'Google Cloud', 'Docker', 'Kubernetes', 'K8s', 'Jenkins', 'Terraform', 'Ansible',
  'CI/CD', 'Git', 'GitHub', 'GitLab', 'Bitbucket', 'DevOps', 'Heroku', 'Vercel', 'Netlify', 'CloudFront', 'S3', 'Lambda', 'EC2',
  'CloudFormation', 'Pulumi', 'Crossplane', 'Helm', 'Kustomize', 'ArgoCD', 'FluxCD',
  'Istio', 'Linkerd', 'Consul', 'Vault', 'Prometheus', 'Grafana', 'ELK Stack',
  'Datadog', 'New Relic', 'Splunk', 'Sumo Logic', 'Nagios', 'Zabbix',
  'PagerDuty', 'Opsgenie', 'VictorOps', 'Travis CI', 'CircleCI', 'Bamboo', 'TeamCity',
  'Octopus Deploy', 'Spinnaker', 'Chef', 'Puppet', 'SaltStack', 'Packer', 'Vagrant',
  'DigitalOcean', 'Linode', 'Alibaba Cloud', 'IBM Cloud', 'Oracle Cloud',
  'Knative', 'OpenShift', 'Rancher', 'Podman', 'Containerd',
  'Terraform Cloud', 'Terragrunt', 'Atlantis',
  'Kubeflow', 'MLflow', 'BentoML', 'Seldon', 'Ray Serve',
  'Cloud Functions', 'Azure Functions', 'Cloud Run',
  'Artifact Registry', 'Container Registry', 'Nexus', 'JFrog Artifactory',
  'Blue-Green Deployment', 'Canary Deployment', 'Rolling Update', 'GitOps',
  'Serverless Framework', 'SAM', 'CDK', 'Terraform CDK',
  'AWS Step Functions', 'AWS Batch', 'AWS ECS', 'AWS EKS', 'AWS Fargate',
  'Azure Kubernetes Service', 'Azure DevOps', 'Azure Pipelines', 'Azure Monitor',
  'GKE', 'Cloud Build', 'Cloud Run for Anthos', 'GCP Cloud Deploy',
  'Prometheus Operator', 'Alertmanager', 'Loki', 'Tempo', 'OpenTelemetry',
  'Service Mesh', 'API Gateway', 'AWS API Gateway', 'Kong', 'Apigee', 'Tyk',

  // ================== MOBILE ==================
  'React Native', 'Flutter', 'Ionic', 'Cordova', 'Android', 'iOS', 'Objective-C', 'Mobile App Development',
  'SwiftUI', 'Jetpack Compose', 'Xamarin', 'NativeScript', 'Capacitor',
  'Unity', 'Unreal Engine', 'Cocos2d', 'Godot', 'GameMaker',
  'Mobile CI/CD', 'Fastlane', 'TestFlight', 'Firebase Test Lab',
  'Kotlin Multiplatform', 'FlutterFlow', 'Ionic Capacitor',
  'Android Jetpack', 'Android SDK', 'iOS SDK', 'CocoaPods', 'Carthage', 'Swift Package Manager',
  'App Store Connect', 'Google Play Console', 'Mobile Analytics', 'Firebase Analytics',
  'Push Notifications', 'FCM', 'APNs', 'In-App Purchases',
  'Mobile UI Design', 'iOS Human Interface Guidelines', 'Material Design',
  'Mobile Accessibility', 'Mobile Performance Optimization',
  'React Native CLI', 'Expo', 'Flutter Widgets', 'Flutter Bloc', 'Provider',

  // ================== TESTING ==================
  'Selenium', 'Testing', 'Manual Testing', 'Automation', 'QA', 'Cypress', 'Jest', 'Mocha', 'Chai', 'JUnit', 'Appium', 'Postman',
  'RSpec', 'Cucumber', 'Gherkin', 'Playwright', 'Puppeteer', 'WebDriverIO',
  'Detox', 'Espresso', 'XCUITest', 'Robot Framework', 'Gatling', 'JMeter',
  'k6', 'Locust', 'Artillery', 'TestCafe', 'Nightwatch', 'Jasmine', 'Karma',
  'React Testing Library', 'Vue Test Utils', 'Supertest', 'Enzyme',
  'SoapUI', 'REST Assured', 'Karate', 'Postman/Newman', 'Insomnia',
  'Accessibility Testing', 'Axe', 'Lighthouse', 'Performance Testing',
  'Contract Testing', 'Pact', 'Spring Cloud Contract',
  'Snapshot Testing', 'Visual Regression Testing', 'Chromatic', 'Percy',
  'Security Testing', 'SAST', 'DAST', 'Penetration Testing',
  'Test Plan', 'Test Strategy', 'Test Case Design', 'Defect Management', 'JIRA',
  'BDD', 'TDD', 'ATDD', 'Exploratory Testing', 'Smoke Testing', 'Regression Testing',

  // ================== DATA SCIENCE, ML & AI ==================
  'Machine Learning', 'AI', 'Data Science', 'Deep Learning', 'Tableau', 'Power BI', 'Excel', 'Pandas', 'NumPy', 'Scikit-learn',
  'PyTorch', 'TensorFlow', 'Keras', 'Big Data', 'Hadoop', 'Spark', 'SQL', 'NoSQL', 'Data Analytics',
  'Jupyter', 'RStudio', 'Apache Airflow', 'Prefect', 'Dagster', 'dbt',
  'OpenCV', 'SpaCy', 'NLTK', 'Hugging Face Transformers', 'FastAI',
  'XGBoost', 'LightGBM', 'CatBoost', 'Statsmodels', 'Prophet',
  'Tidyverse', 'Caret', 'mlr3', 'Dask', 'Polars', 'Modin',
  'Matplotlib', 'Seaborn', 'Plotly', 'Bokeh', 'Streamlit', 'Gradio',
  'Shiny', 'Dash', 'Looker', 'Qlik', 'Alteryx', 'KNIME', 'RapidMiner',
  'Apache Flink', 'Apache Beam', 'Apache Storm', 'Apache Samza',
  'Feature Engineering', 'Model Deployment', 'A/B Testing', 'Experiment Design',
  'Data Warehousing', 'ETL', 'ELT', 'Data Pipelines', 'Data Integration',
  'Data Governance', 'Data Quality', 'Master Data Management',
  'MLOps', 'Model Monitoring', 'Feature Store', 'Feast',
  'Computer Vision', 'NLP', 'Speech Recognition', 'Recommendation Systems',
  'Time Series Analysis', 'Anomaly Detection', 'Clustering', 'Classification',
  'Reinforcement Learning', 'GANs', 'AutoML', 'Data Labeling',
  'Apache Arrow', 'Apache Parquet', 'Avro', 'ORC',
  'Graph Analytics', 'NetworkX', 'Gephi',
  'Statistics', 'Hypothesis Testing', 'Bayesian Methods', 'Causal Inference',

  // ================== CYBERSECURITY ==================
  'Cybersecurity', 'Ethical Hacking', 'Pentesting', 'Information Security', 'OAuth', 'JWT', 'SSL', 'Cryptography', 'Firewalls',
  'Burp Suite', 'Wireshark', 'Nmap', 'Metasploit', 'Kali Linux', 'OWASP ZAP',
  'Snort', 'Suricata', 'Nessus', 'Qualys', 'OpenVAS', 'CrowdStrike',
  'SentinelOne', 'Carbon Black', 'McAfee', 'Symantec', 'Palo Alto Networks',
  'Fortinet', 'Check Point', 'IDS', 'IPS', 'SIEM', 'SOAR',
  'IAM', 'SAML', 'LDAP', 'Active Directory', 'RBAC', 'ABAC',
  'GDPR', 'HIPAA', 'PCI DSS', 'ISO 27001', 'NIST', 'SOC 2',
  'Zero Trust', 'Vulnerability Assessment', 'Incident Response', 'Forensics',
  'Malware Analysis', 'Reverse Engineering', 'Social Engineering', 'Phishing',
  'Ransomware', 'DLP', 'CASB', 'SWG', 'PKI', 'HSM', 'Key Management',
  'Threat Intelligence', 'OSINT', 'Dark Web Monitoring',
  'Red Team', 'Blue Team', 'Purple Team', 'DevSecOps',
  'Application Security', 'Network Security', 'Endpoint Security',
  'XDR', 'EDR', 'MDR', 'ZTNA', 'SASE',
  'Security Operations Center', 'Threat Hunting', 'Digital Forensics',
  'Cloud Security', 'Container Security', 'Kubernetes Security',
  'Code Signing', 'Secure Coding', 'Vulnerability Scanning',
  'WAF', 'DDoS Protection', 'Bot Management',

  // ================== DESIGN & MULTIMEDIA ==================
  'Photoshop', 'Illustrator', 'InDesign', 'Canva', 'Sketch', 'Premiere Pro', 'After Effects', 'Video Editing', 'Graphic Design',
  'Blender', 'Maya', 'Cinema 4D', '3ds Max', 'ZBrush', 'Substance Painter',
  'Houdini', 'GIMP', 'Affinity Designer', 'Affinity Photo', 'Affinity Publisher',
  'CorelDRAW', 'Lightroom', 'DaVinci Resolve', 'Final Cut Pro', 'Avid Media Composer',
  'Logic Pro', 'Ableton Live', 'FL Studio', 'Pro Tools', 'Audacity', 'GarageBand',
  'InVision', 'Axure RP', 'Balsamiq', 'Miro', 'Framer', 'Proto.io', 'Marvel', 'Zeplin',
  'Principle', 'Origami Studio', 'SketchUp', 'Rhino', 'AutoCAD', 'SolidWorks',
  'UX Research', 'Wireframing', 'Prototyping', 'Interaction Design', 'Visual Design',
  'Motion Graphics', '3D Modeling', 'Animation', 'VFX', 'Video Production',
  'Audio Editing', 'Sound Design', 'Game Design', 'AR/VR Design',
  'Typography', 'Color Theory', 'Layout Design', 'Branding', 'Logo Design',
  'Storyboarding', 'Motion Design', 'Illustration', 'Digital Painting',
  'Character Design', 'Environment Design', 'Concept Art',
  'Figma Variants', 'Auto Layout', 'Design Systems', 'Design Tokens',
  'Accessible Design', 'WCAG', 'Inclusive Design',
  'Print Design', 'Packaging Design', 'Environmental Graphics',
  'UI Animation', 'Lottie', 'Rive', 'Haiku',
  'CAD/CAM', 'Fusion 360', 'Creo', 'Catia', 'NX',

  // ================== PROJECT MANAGEMENT ==================
  'Project Management', 'Agile', 'Scrum', 'Kanban', 'Jira', 'Trello', 'Asana', 'Confluence', 'Slack', 'Monday.com',
  'ClickUp', 'Wrike', 'Basecamp', 'Notion', 'Airtable', 'Smartsheet',
  'Microsoft Project', 'Planner', 'Todoist', 'Evernote', 'OneNote',
  'Google Workspace', 'Microsoft 365', 'SharePoint', 'Teams', 'Zoom', 'Webex',
  'Loom', 'Time Doctor', 'Toggl', 'Harvest', 'Clockify', 'RescueTime',
  'Lean', 'Six Sigma', 'PRINCE2', 'PMP', 'CAPM',
  'Risk Management', 'Stakeholder Management', 'Budgeting', 'Resource Allocation',
  'Change Management', 'Release Management', 'SAFe', 'LeSS',
  'ServiceNow', 'Jira Service Management', 'Zendesk', 'Freshservice',
  'Project Charter', 'Scope Statement', 'Work Breakdown Structure',
  'Gantt Chart', 'Critical Path', 'Earned Value Management',
  'Sprint Planning', 'Daily Standup', 'Sprint Review', 'Retrospective',
  'User Stories', 'Epics', 'Acceptance Criteria', 'Definition of Done',
  'OKRs', 'KPIs', 'Roadmapping', 'Program Management', 'Portfolio Management',

  // ================== BUSINESS, SALES & MARKETING ==================
  'Sales', 'Marketing', 'Accounting', 'Financing', 'HRMS', 'ERP', 'SAP', 'Salesforce', 'CRM', 'Copywriting', 'SEO', 'SEM',
  'Business Analysis', 'Product Management', 'Recruitment', 'Talent Acquisition', 'Operations', 'Supply Chain',
  'Digital Marketing', 'Content Marketing', 'Social Media Marketing', 'Email Marketing',
  'Affiliate Marketing', 'Growth Hacking', 'Conversion Rate Optimization', 'Google Analytics',
  'Google Tag Manager', 'Hotjar', 'Crazy Egg', 'Optimizely', 'VWO',
  'Mixpanel', 'Amplitude', 'Heap', 'Segment', 'Customer Data Platform',
  'Customer Success', 'Account Management', 'Business Development', 'Lead Generation',
  'Cold Calling', 'B2B Sales', 'B2C Sales', 'SaaS Sales', 'Negotiation', 'Contract Management',
  'Procurement', 'Vendor Management', 'Logistics', 'Inventory Management',
  'Warehouse Management', 'Transportation Management', 'Fleet Management',
  'Demand Planning', 'Forecasting', 'S&OP', 'E-commerce',
  'Stripe', 'PayPal', 'Square', 'QuickBooks', 'Xero', 'FreshBooks', 'Wave',
  'SAP FICO', 'SAP MM', 'SAP SD', 'SAP HCM', 'SAP SuccessFactors',
  'Oracle EBS', 'NetSuite', 'Microsoft Dynamics', 'Workday', 'ADP',
  'BambooHR', 'Gusto', 'Zoho', 'Pipedrive', 'HubSpot CRM', 'SugarCRM',
  'Intercom', 'Drift', 'LiveChat', 'Typeform', 'SurveyMonkey', 'Qualtrics',
  'Microsoft Forms', 'Google Forms', 'DocuSign', 'Adobe Sign',
  'Salesforce CPQ', 'Salesforce Marketing Cloud', 'Salesforce Service Cloud',
  'Salesforce Commerce Cloud', 'Microsoft Power Platform',
  'HubSpot Marketing Hub', 'Marketo', 'Mailchimp', 'SendGrid', 'Sendinblue', 'ConvertKit',
  'Google Ads', 'Facebook Ads', 'LinkedIn Ads', 'Programmatic Advertising',
  'Inbound Marketing', 'Outbound Marketing', 'Account-Based Marketing',
  'Brand Strategy', 'Market Research', 'Competitive Analysis',
  'Pricing Strategy', 'Revenue Operations', 'Sales Enablement',
  'Customer Lifecycle', 'Churn Reduction', 'NPS', 'CSAT',
  'ERPNext', 'Odoo', 'Syspro', 'IFS', 'Epicor',

  // ================== SOFT SKILLS ==================
  'Communication', 'Leadership', 'Teamwork', 'Problem Solving', 'Time Management', 'Critical Thinking', 'Adaptability', 'Emotional Intelligence',
  'Negotiation', 'Conflict Resolution', 'Empathy', 'Decision Making', 'Creativity',
  'Mentoring', 'Coaching', 'Public Speaking', 'Presentation Skills', 'Persuasion',
  'Collaboration', 'Active Listening', 'Interpersonal Skills', 'Cultural Awareness',
  'Diversity & Inclusion', 'Patience', 'Resilience', 'Stress Management',
  'Work Ethic', 'Reliability', 'Attention to Detail', 'Organization', 'Planning',
  'Prioritization', 'Multitasking', 'Goal Setting', 'Self-Motivation', 'Initiative',
  'Analytical Thinking', 'Logical Reasoning', 'Research', 'Learning Agility',
  'Teaching', 'Training', 'Facilitation', 'Mediation', 'Networking',
  'Relationship Building', 'Customer Service', 'Business Acumen', 'Strategic Thinking',
  'Vision', 'Innovation', 'Curiosity', 'Resourcefulness', 'Empowerment', 'Delegation',
  'Influence', 'Trust Building', 'Accountability', 'Transparency', 'Integrity',
  'Ethics', 'Storytelling', 'Mindfulness', 'Grit', 'Perseverance', 'Optimism',
  'Self-Confidence', 'Self-Awareness', 'Self-Regulation', 'Social Skills',

  // ================== HEALTHCARE & MEDICAL ==================
  'Patient Care', 'Nursing', 'Medical Terminology', 'Clinical Research', 'Phlebotomy', 'EKG', 'CPR', 'First Aid', 'ACLS',
  'Home Health', 'Hospice', 'Pediatrics', 'Geriatrics', 'Mental Health', 'Counseling', 'Therapy', 'Rehabilitation',
  'Occupational Therapy', 'Physical Therapy', 'Speech Therapy', 'Respiratory Therapy', 'Radiology', 'Ultrasound',
  'MRI', 'CT Scan', 'Pharmacy', 'Pharmacology', 'Medication Administration', 'Surgical Assisting', 'Sterilization',
  'Infection Control', 'Patient Advocacy', 'Health Education', 'Epidemiology', 'Public Health', 'Health Informatics',
  'ICD-10', 'CPT Coding', 'Medical Billing', 'Medical Transcription', 'EMR/EHR', 'Cerner', 'Epic', 'Allscripts',
  'Vital Signs', 'Patient Assessment', 'Wound Care', 'IV Therapy', 'Catheterization',
  'Oncology', 'Cardiology', 'Neurology', 'Orthopedics', 'Psychiatry',
  'Clinical Documentation', 'Medical Coding', 'Revenue Cycle Management',
  'Telemedicine', 'Remote Patient Monitoring', 'HIPAA Compliance',
  'Medical Devices', 'FDA Approval', 'Clinical Trials',
  'Occupational Health', 'School Nursing', 'Travel Nursing',

  // ================== LEGAL ==================
  'Legal Research', 'Litigation', 'Contract Law', 'Corporate Law', 'Family Law', 'Criminal Law', 'Immigration Law',
  'Intellectual Property', 'Patent Law', 'Trademark', 'Copyright', 'Compliance', 'Regulatory Affairs', 'Paralegal',
  'Legal Writing', 'Depositions', 'Trial Preparation', 'Arbitration', 'Mediation', 'Due Diligence',
  'Notary Public', 'Westlaw', 'LexisNexis', 'Case Management', 'eDiscovery',
  'Employment Law', 'Real Estate Law', 'Environmental Law', 'Tax Law', 'Bankruptcy',
  'Legal Ethics', 'Client Counseling', 'Legal Drafting', 'Brief Writing',
  'Litigation Support', 'Document Review', 'Contract Drafting', 'Compliance Program',
  'Freedom of Information', 'Public Records', 'Legislative Drafting',
  'Judicial Clerkship', 'Legal Operations', 'Practice Management',

  // ================== FINANCE & ACCOUNTING ==================
  'Financial Analysis', 'Financial Reporting', 'GAAP', 'IFRS', 'Auditing', 'Internal Audit', 'External Audit',
  'Tax Preparation', 'Tax Planning', 'Corporate Tax', 'Payroll', 'Accounts Payable', 'Accounts Receivable',
  'General Ledger', 'Cost Accounting', 'Management Accounting', 'Financial Modeling', 'Valuation', 'M&A',
  'Due Diligence (Finance)', 'Risk Assessment', 'Credit Analysis', 'Investment Banking', 'Portfolio Management',
  'Wealth Management', 'Asset Management', 'Fund Accounting', 'Hedge Funds', 'Private Equity', 'Venture Capital',
  'Bloomberg Terminal', 'FactSet', 'Morningstar', 'Sage', 'Tally', 'CCH Axcess', 'Thomson Reuters',
  'Bookkeeping', 'Bank Reconciliation', 'Trial Balance', 'Financial Statements',
  'Budgeting', 'Forecasting', 'Variance Analysis', 'Treasury Management',
  'Capital Markets', 'Fixed Income', 'Equity Research', 'Derivatives',
  'Risk Management', 'Compliance', 'Anti-Money Laundering', 'KYC', 'SOX',
  'QuickBooks Online', 'Xero', 'FreshBooks', 'Zoho Books', 'Wave Accounting',
  'Advanced Excel', 'Power Query', 'Pivot Tables', 'VBA', 'Macros',

  // ================== REAL ESTATE ==================
  'Real Estate Sales', 'Property Management', 'Leasing', 'Tenant Relations', 'Escrow', 'Title Insurance',
  'Appraisal', 'Real Estate Finance', 'Commercial Real Estate', 'Residential Real Estate', 'Property Inspection',
  'MLS', 'RE/MAX', 'Zillow', 'CoStar', 'LoopNet', 'Yardi', 'AppFolio', 'Buildium',
  'Real Estate Development', 'Property Valuation', 'Market Analysis',
  'Facility Management', 'Building Maintenance', 'Janitorial Services',
  'Lease Administration', 'CAM Reconciliation', 'Real Estate Law',
  '1031 Exchange', 'REIT', 'Mortgage Lending', 'Loan Origination',
  'Commercial Leasing', 'Tenant Improvement', 'Space Planning',

  // ================== EDUCATION & TEACHING ==================
  'Curriculum Development', 'Lesson Planning', 'Classroom Management', 'Special Education', 'ESL', 'TESOL',
  'TEFL', 'Instructional Design', 'E-Learning', 'Moodle', 'Blackboard', 'Canvas', 'Google Classroom',
  'Educational Technology', 'Student Assessment', 'Tutoring', 'Adult Education', 'Higher Education',
  'Research Methodology', 'Academic Writing', 'Grant Writing', 'Library Science', 'Literacy',
  'Pedagogy', 'Andragogy', 'Blended Learning', 'Flipped Classroom',
  'STEM Education', 'Arts Education', 'Physical Education',
  'Distance Learning', 'Hybrid Learning', 'Microlearning',
  'EdTech', 'LMS Administration', 'SCORM', 'xAPI',
  'Student Affairs', 'Academic Advising', 'Career Counseling',
  'Substitute Teaching', 'Montessori', 'Waldorf', 'Reggio Emilia',

  // ================== HOSPITALITY & TOURISM ==================
  'Hospitality Management', 'Hotel Operations', 'Front Desk', 'Concierge', 'Housekeeping Management',
  'Food & Beverage', 'Culinary Arts', 'Pastry', 'Barista', 'Wine Knowledge', 'Sommelier',
  'Event Planning', 'Wedding Planning', 'Catering', 'Restaurant Management', 'POS Systems', 'OpenTable',
  'Travel Planning', 'Tour Guiding', 'Cruise Line', 'Airline Operations', 'Amadeus', 'Sabre',
  'Guest Relations', 'Service Excellence', 'Fine Dining',
  'Banquet Operations', 'Menu Engineering', 'Food Safety', 'HACCP',
  'Hotel Revenue Management', 'Yield Management', 'Channel Manager',
  'Vacation Rental Management', 'Airbnb', 'VRBO',
  'Spa Management', 'Golf Course Management', 'Theme Park Operations',

  // ================== RETAIL & SALES ==================
  'Retail Management', 'Visual Merchandising', 'Inventory Control', 'Loss Prevention', 'Cashiering',
  'Shopper Marketing', 'Category Management', 'Merchandise Planning', 'Store Operations',
  'Direct Sales', 'Inside Sales', 'Outside Sales', 'Channel Sales', 'Solution Selling', 'Consultative Selling',
  'SPIN Selling', 'Challenger Sale', 'Pipeline Management', 'Quota Attainment', 'Salesforce Automation',
  'POS Terminal', 'Square POS', 'Shopify POS', 'Lightspeed',
  'E-commerce Management', 'Omnichannel Retailing', 'Buying & Merchandising',
  'Fashion Retail', 'Grocery Retail', 'Luxury Retail', 'Pop-up Stores',
  'Store Setup', 'Staff Training', 'Customer Experience', 'Loyalty Programs',
  'Retail Analytics', 'Foot Traffic Analysis', 'Heatmaps',

  // ================== MANUFACTURING & INDUSTRIAL ==================
  'Lean Manufacturing', '5S', 'Kaizen', 'Six Sigma Green Belt', 'Six Sigma Black Belt', 'TPM',
  'ISO 9001', 'ISO 13485', 'Quality Control', 'Quality Assurance', 'Root Cause Analysis', 'CAPA',
  'GMP', 'FDA Regulations', 'OSHA', 'Workplace Safety', 'Machining', 'CNC Programming', 'Welding',
  'PLC Programming', 'SCADA', 'HMI', 'Industrial Automation', 'Robotics', 'CAD', 'CAM',
  'Supply Chain Planning', 'Procurement (Manufacturing)', 'Sourcing', 'MRP', 'ERP (Manufacturing)',
  'SAP PP', 'SAP QM', 'SAP WM', 'Oracle Manufacturing',
  'Production Scheduling', 'Capacity Planning', 'Shop Floor Control',
  'Maintenance Management', 'CMMS', 'Predictive Maintenance',
  'Tooling', 'Jigs & Fixtures', 'Die Casting', 'Injection Molding',
  'Additive Manufacturing', '3D Printing', 'Sheet Metal', 'Fabrication',
  'Cleanroom', 'Semiconductor', 'Textile Manufacturing', 'Food Processing',

  // ================== CONSTRUCTION & TRADES ==================
  'Construction Management', 'Site Supervision', 'Blueprint Reading', 'Estimating', 'Scheduling',
  'HVAC', 'Electrical', 'Plumbing', 'Carpentry', 'Masonry', 'Painting', 'Roofing', 'Flooring',
  'Heavy Equipment Operation', 'Crane Operation', 'Forklift', 'OSHA 30', 'Building Codes',
  'Green Building', 'LEED', 'BIM', 'Revit', 'Navisworks', 'Procore', 'PlanGrid',
  'Construction Safety', 'Surveying', 'Excavation', 'Demolition',
  'Concrete', 'Steel Erection', 'Scaffolding', 'Drywall', 'Insulation',
  'Residential Construction', 'Commercial Construction', 'Industrial Construction',
  'Renovation', 'Remodeling', 'Historic Preservation',
  'MEP', 'Fire Protection', 'Security Systems',
  'Site Logistics', 'Material Takeoff', 'Change Orders',

  // ================== TRANSPORTATION & LOGISTICS ==================
  'CDL', 'Truck Driving', 'Delivery Driver', 'Dispatch', 'Route Planning', 'Fleet Maintenance',
  'Freight Forwarding', 'Customs Brokerage', 'Import/Export', 'Incoterms', 'Cargo Handling',
  'Shipping', 'Receiving', 'Cross-Docking', '3PL', 'Fourth-Party Logistics', 'Reverse Logistics',
  'Transportation Management System', 'OTM', 'Blue Yonder', 'Manhattan Associates',
  'Warehouse Operations', 'Picking & Packing', 'Inventory Accuracy',
  'Courier Services', 'Last Mile Delivery', 'Cold Chain',
  'Fleet Management', 'Telematics', 'DOT Compliance',
  'Air Freight', 'Ocean Freight', 'Rail Freight', 'Intermodal',
  'Supply Chain Visibility', 'Control Tower',

  // ================== AGRICULTURE & ENVIRONMENTAL ==================
  'Agronomy', 'Horticulture', 'Livestock Management', 'Veterinary', 'Pest Control',
  'Irrigation', 'Crop Management', 'Soil Science', 'Organic Farming', 'Sustainable Agriculture',
  'Environmental Science', 'Waste Management', 'Recycling', 'Water Treatment', 'Air Quality',
  'Environmental Compliance', 'Renewable Energy', 'Solar Energy', 'Wind Energy',
  'GIS', 'Remote Sensing', 'ArcGIS', 'QGIS',
  'Precision Agriculture', 'Farm Equipment', 'Harvesting',
  'Greenhouse Management', 'Aquaculture', 'Hydroponics',
  'Forestry', 'Wildlife Management', 'Conservation',
  'Climate Change', 'Carbon Footprint', 'EIA',

  // ================== ARTS, MEDIA & ENTERTAINMENT ==================
  'Fine Arts', 'Painting', 'Drawing', 'Sculpture', 'Illustration', 'Printmaking',
  'Photography', 'Portrait Photography', 'Landscape Photography', 'Photo Editing',
  'Music Performance', 'Music Theory', 'Music Composition', 'DJ', 'Audio Engineering',
  'Acting', 'Theater', 'Film Production', 'Directing', 'Screenwriting', 'Cinematography',
  'Broadcasting', 'Radio', 'Podcasting', 'Journalism', 'News Writing', 'Investigative Reporting',
  'Editing', 'Proofreading', 'Publishing', 'Literary Agent',
  'Creative Writing', 'Poetry', 'Playwriting', 'Comedy Writing',
  'Stand-up Comedy', 'Improvisation', 'Voice Acting', 'Puppetry',
  'Stage Management', 'Lighting Design', 'Sound Design',
  'Art Direction', 'Set Design', 'Costume Design', 'Makeup FX',
  'Curating', 'Museum Studies', 'Gallery Management',
  'Film Editing', 'Color Grading', 'Visual Effects', 'Animation',
  'Event Production', 'Festival Management', 'Talent Booking',

  // ================== GOVERNMENT & NON-PROFIT ==================
  'Public Administration', 'Policy Analysis', 'Urban Planning', 'Community Development',
  'Fundraising', 'Donor Relations', 'Volunteer Management', 'Program Management (NGO)',
  'Advocacy', 'Lobbying', 'Legislative Affairs', 'Emergency Management',
  'Firefighting', 'Law Enforcement', 'Corrections', 'Homeland Security',
  'Military', 'Veteran Affairs', 'International Relations', 'Diplomacy', 'Foreign Language',
  'Government Contracting', 'Grants Management', 'Public Policy',
  'Social Services', 'Child Welfare', 'Disaster Response',
  'Intelligence Analysis', 'Counterterrorism', 'Border Security',
  'City Planning', 'Zoning', 'Code Enforcement',
  'Elections', 'Campaign Management', 'Political Fundraising',

  // ================== HUMAN RESOURCES & ADMINISTRATION ==================
  'Onboarding', 'Offboarding', 'Benefits Administration', 'Compensation & Benefits',
  'Workforce Planning', 'Succession Planning', 'Employee Engagement', 'HRIS',
  'PeopleSoft', 'UKG', 'Kronos', 'Ceridian', 'Paylocity',
  'Labor Law', 'FMLA', 'EEO', 'Affirmative Action', 'Workplace Investigation',
  'Office Management', 'Reception', 'Scheduling', 'Data Entry', 'Filing',
  'Travel Arrangement', 'Expense Reporting', 'Concur', 'Oracle Fusion HCM',
  'Performance Management', '360 Feedback', 'Competency Models',
  'HR Analytics', 'People Analytics', 'Culture Building',
  'Remote Work Policy', 'Flexible Work Arrangements', 'Employee Wellness',
  'Internal Communication', 'Intranet', 'Corporate Events',

  // ================== CUSTOMER SERVICE & SUPPORT ==================
  'Contact Center', 'Call Center', 'Help Desk', 'Ticketing System',
  'Live Chat Support', 'Omnichannel Support', 'First Call Resolution', 'Customer Satisfaction',
  'Net Promoter Score', 'Complaint Resolution', 'Escalation Management',
  'Zendesk (Support)', 'Freshdesk', 'Intercom (Support)', 'Salesforce Service', 'Jira Service Desk',
  'Customer Feedback', 'Voice of Customer', 'Service Recovery',
  'Technical Support', 'Product Support', 'Warranty Claims',
  'Order Management', 'Returns & Exchanges',
  'Knowledge Base Management', 'Self-Service Portal',

  // ================== MISCELLANEOUS NON-TECH ==================
  'Life Coaching', 'Career Counseling', 'Nutrition', 'Fitness Training', 'Yoga Instruction',
  'Personal Training', 'Wellness Coaching', 'Beauty', 'Cosmetology', 'Esthetics',
  'Nail Technician', 'Barbering', 'Massage Therapy', 'Spa Management',
  'Fashion Design', 'Textile', 'Pattern Making', 'Interior Design', 'Home Staging',
  'Landscaping', 'Floristry', 'Animal Care', 'Pet Grooming', 'Dog Training',
  'Driving Instruction', 'Security Guard', 'Private Investigation', 'Locksmith',
  'Appliance Repair', 'Electronics Repair', 'Jewelry Making', 'Woodworking',
  'Pottery', 'Baking', 'Cooking', 'Event Production', 'Tour Management',
  'Astrology', 'Tarot Reading', 'Feng Shui', 'Reiki', 'Acupuncture',
  'Tattoo Artistry', 'Piercing', 'Makeup Artistry', 'Body Art',
  'Sewing', 'Knitting', 'Crochet', 'Quilting', 'Embroidery',
  'Calligraphy', 'Hand Lettering', 'Scrapbooking',
  'Beekeeping', 'Soap Making', 'Candle Making', 'Home Brewing',

  // ================== NICHE TECH, TOOLS & FRAMEWORKS ==================
  'LitElement', 'Haunted', 'Fable', 'Elm', 'ReasonML', 'PureScript', 'Crystal', 'Nim', 'Zig', 'Odin',
  'Ballarina', 'Bosque', 'Pony', 'Factor', 'Forth', 'J', 'APL', 'BCPL', 'Icon', 'Squirrel',
  'Ladder Logic', 'Function Block Diagram', 'Structured Text', 'Sequential Function Chart',
  'LDAP', 'Kerberos', 'RADIUS', 'TACACS+', 'OAuth2', 'OpenID Connect', 'SCIM',
  'SAP Gateway', 'SAP Fiori', 'SAP BTP', 'SAP Ariba', 'SAP Concur', 'SAP Fieldglass',
  'Salesforce Einstein', 'Salesforce Lightning', 'Salesforce Apex', 'Salesforce Visualforce',
  'Microsoft Fabric', 'Power Query', 'DAX', 'MDX', 'SSIS', 'SSRS', 'SSAS',
  'Data Vault', 'Star Schema', 'Snowflake Schema', 'Slowly Changing Dimension',
  'Apache Iceberg', 'Delta Lake', 'Hudi', 'Parquet', 'Avro', 'ORC', 'Arrow',
  'Flink SQL', 'Beam SQL', 'KsqlDB', 'Materialize', 'RisingWave',
  'Neovim', 'Emacs', 'VS Code', 'IntelliJ IDEA', 'PyCharm', 'WebStorm', 'Eclipse', 'NetBeans',
  'DBeaver', 'pgAdmin', 'DataGrip', 'Navicat', 'Toad', 'SQL Developer', 'SSMS',
  'Fiddler', 'Charles Proxy', 'Postman Interceptor', 'GraphiQL', 'Altair',
  'Truffle', 'Hardhat', 'Foundry', 'Ganache', 'MetaMask', 'Web3.js', 'Ethers.js',
  'IPFS', 'Filecoin', 'Arweave', 'The Graph', 'Chainlink',
  'Blockchain', 'DeFi', 'NFT', 'DAO', 'Smart Contracts',

  // ================== MORE INDUSTRY & FUNCTIONAL SKILLS ==================
  'Clinical Trial Management', 'CRF Design', 'Data Management (Clinical)', 'CDISC', 'SDTM', 'ADaM',
  'Pharmacovigilance', 'Regulatory Submission', 'eCTD', 'Documentum', 'Veeva Vault',
  'Medical Writing', 'Biostatistics', 'SAS', 'STATA', 'SPSS', 'GraphPad Prism',
  'Energy Trading', 'Risk Management (Energy)', 'ETRM', 'Allegro', 'OpenLink', 'Triple Point',
  'Pipeline Operations', 'Drilling', 'Reservoir Engineering', 'Petrel', 'ECLIPSE',
  'Structural Engineering', 'STAAD', 'SAP2000', 'ETABS', 'ANSYS', 'ABAQUS', 'COMSOL',
  'MATLAB Simulink', 'LabVIEW', 'Automotive Engineering', 'CAN', 'LIN', 'UDS', 'ISO 26262',
  'Aerospace', 'Satellite', 'Avionics', 'DO-178C', 'DO-254', 'Model-Based Design',
  'Claims Adjusting', 'Underwriting', 'Actuarial Science', 'P&C Insurance', 'Life Insurance',
  'Guidewire', 'Duck Creek', 'Insurity', 'ISO ClaimSearch',
  'Mortgage Lending', 'Loan Origination', 'Credit Risk', 'Collections', 'Anti-Money Laundering',
  'KYC', 'CDD', 'Transaction Monitoring', 'Actimize', 'FICO', 'Experian', 'Equifax', 'TransUnion',
  'Digital Forensics', 'EnCase', 'FTK', 'Cellebrite', 'X-Ways', 'Volatility',
  'SCA', 'SAST', 'DAST', 'Checkmarx', 'Veracode', 'SonarQube', 'Fortify',
  'API Security', 'Container Security', 'Cloud Security Posture Management', 'Prisma Cloud',
  'Medical Device', 'QMS', 'ISO 14971', 'IEC 62304', 'Design Controls',
  'Biotech', 'CRISPR', 'Genomics', 'Bioinformatics', 'Sequencing', 'Microfluidics',

  // ================== CREATIVE & PERFORMANCE ==================
  'Voice Acting', 'Dubbing', 'Foley Art', 'Color Grading', 'Compositing', 'Match Moving',
  'DIT', 'Gaffer', 'Key Grip', 'Boom Operator', 'Production Design', 'Art Direction',
  'Set Design', 'Costume Design', 'Makeup FX', 'Prosthetics', 'Puppetry',
  'Dramaturgy', 'Stage Management', 'Lighting Design', 'Sound Engineering (Live)',
  'Choreography', 'Dance Instruction', 'Vocal Coaching', 'Improvisation',
  'Circus Arts', 'Stunts', 'Fight Choreography', 'Magic',
  'Floral Design', 'Ikebana', 'Topiary', 'Bonsai', 'Aquascaping',

  // ================== LANGUAGES & CERTIFICATION BODIES ==================
  'TOEIC', 'IELTS', 'TOEFL', 'DELE', 'DELF', 'DALF', 'JLPT', 'HSK',
  'CISSP', 'CISA', 'CISM', 'CEH', 'OSCP', 'CompTIA A+', 'CompTIA Network+', 'CompTIA Security+',
  'AWS Certified Solutions Architect', 'AWS Certified Developer', 'AWS Certified DevOps Engineer',
  'Microsoft Certified: Azure Fundamentals', 'Azure Administrator', 'Azure Solutions Architect',
  'Google Cloud Professional Cloud Architect', 'Google Cloud Data Engineer',
  'PMI-ACP', 'CSM', 'CSPO', 'PSM', 'PSPO', 'ITIL', 'CIMA', 'ACCA', 'CFA', 'FRM', 'CMA',
  'Six Sigma Yellow Belt', 'Six Sigma Master Black Belt', 'Lean Practitioner',

  // ================== SUPPLY CHAIN & OPERATIONS DEEP DIVE ==================
  'Value Stream Mapping', 'Theory of Constraints', 'Vendor Managed Inventory', 'Drop Shipping',
  'Last Mile Delivery', 'Cold Chain', 'Customs Compliance', 'Dangerous Goods',
  'Supply Chain Visibility', 'Control Tower', 'Kinaxis', 'o9 Solutions', 'E2open',
  'Demantra', 'Oracle ASCP', 'SAP IBP', 'SAP TM', 'SAP EWM',
  'Trade Compliance', 'Duty Drawback', 'FTZ', 'Bonded Warehouse',
  'Supplier Relationship Management', 'Strategic Sourcing', 'Procure-to-Pay',
  'Order-to-Cash', 'Record-to-Report', 'Inventory Optimization',

  // ================== MORE SOFT & COGNITIVE ==================
  'Design Thinking', 'Systems Thinking', 'Lateral Thinking', 'First Principles',
  'Socratic Method', 'Mind Mapping', 'Visual Note-Taking', 'Rapid Prototyping',
  'User Empathy', 'Customer Journey Mapping', 'Service Blueprint', 'Empathy Map',
  'Heuristic Evaluation', 'Cognitive Walkthrough', 'Usability Testing', 'A/B Testing',
  'FMEA', 'HAZOP', 'SWOT Analysis', 'PESTLE', "Porter's Five Forces",
  'Blue Ocean Strategy', 'Ansoff Matrix', 'McKinsey 7S', 'BCG Matrix',
  'Must-Haves', 'Nice-to-Haves', 'MoSCoW', 'RICE Scoring', 'ICE Scoring',
  'Nonviolent Communication', 'Crucial Conversations', 'Fierce Conversations',
  'Executive Presence', 'Personal Branding', 'LinkedIn Optimization', 'Resume Writing',
  'Interviewing', 'Job Search Strategy', 'Salary Negotiation', 'Freelancing',
  'Solopreneurship', 'Side Hustle', 'Product-Market Fit',

  // ================== FUN / EMERGING / NICHE ==================
  'Biohacking', 'Quantified Self', 'Nootropics', 'Smart Home Automation', 'Home Assistant',
  '3D Printing', 'Laser Cutting', 'CNC Milling', 'PCB Design', 'Arduino', 'Raspberry Pi',
  'Drone Piloting', 'FPV', 'Amateur Radio', 'Ham Radio', 'Antenna Theory',
  'Astronomy', 'Astrophotography', 'Meteorology', 'Oceanography',
  'Archaeology', 'Paleontology', 'Genealogy', 'Forensic Anthropology',
  'Mixology', 'Craft Beer Brewing', 'Cheesemaking', 'Fermentation', 'Foraging',
  'Survival Skills', 'Bushcraft', 'Mountaineering', 'Scuba Diving', 'Free Diving',
  'Skydiving', 'Paragliding', 'Rock Climbing', 'White Water Rafting', 'Orienteering',
  'Spelunking', 'Canyoning', 'Bouldering', 'Trail Running', 'Ultramarathon',
  'Poker', 'Chess', 'Go', 'Bridge', 'Mahjong', 'Esports',
  'Speedcubing', 'Memory Sports', 'Debate', 'Model United Nations',
  'Cosplay', 'LARPing', 'Board Game Design', 'Worldbuilding'
];

    const detectedSkills = [];
    skillsDictionary.forEach(skill => {
        const regex = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        if (regex.test(text)) {
            detectedSkills.push(skill);
        }
    });

    // 5. Total Experience (Heuristics)
    // Look for numbers followed by "years" or "exp"
    const expRegex = /(\d+(?:\.\d+)?)\s*(?:years?|yrs?)(?:\s*(?:of)?\s*experience|\s*exp)?/gi;
    let totalExperience = '';
    const expMatches = text.matchAll(expRegex);
    for (const match of expMatches) {
        // Usually the largest number for experience is the total experience
        const years = parseFloat(match[1]);
        if (!totalExperience || years > totalExperience) {
            totalExperience = years;
        }
    }

    return {
        candidateName: name,
        email,
        mobile,
        totalExperience: totalExperience ? totalExperience.toString() : '',
        mustHaveSkills: [],
        niceToHaveSkills: detectedSkills.map(s => ({ skill: s, experience: '' }))
    };
}

module.exports = { parseCV };
