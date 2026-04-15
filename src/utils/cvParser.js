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
        // Frontend
        'React', 'Next.js', 'Node.js', 'Express', 'JavaScript', 'JS', 'TypeScript', 'TS', 'Angular', 'Vue.js', 'Svelte',
        'HTML', 'HTML5', 'CSS', 'CSS3', 'Tailwind', 'TailwindCSS', 'SASS', 'SCSS', 'Bootstrap', 'Redux', 'Zustand', 'Context API', 'GraphQL',
        'Vite', 'Webpack', 'Babel', 'Figma', 'Adobe XD', 'UI', 'UX', 'Responsive Design', 'Material UI', 'Ant Design', 'Chakra UI',
        // Backend & Languages
        'Python', 'Java', 'C++', 'C#', 'PHP', 'Ruby', 'Ruby on Rails', 'Golang', 'Go Language', 'Rust', 'Scala', 'Kotlin', 'Swift',
        'Spring Boot', 'Django', 'Flask', 'NestJS', 'Laravel', 'ASP.NET', 'Koa', 'Strapi', 'FastAPI', 'Microservices', 'Serverless',
        // Databases
        'PostgreSQL', 'MongoDB', 'MySQL', 'Redis', 'Oracle', 'SQLite', 'MariaDB', 'Firebase', 'Cassandra', 'DynamoDB', 'Elasticsearch', 'Mongoose',
        // Cloud & DevOps
        'AWS', 'Azure', 'GCP', 'Google Cloud', 'Docker', 'Kubernetes', 'K8s', 'Jenkins', 'Terraform', 'Ansible', 
        'CI/CD', 'Git', 'GitHub', 'GitLab', 'Bitbucket', 'DevOps', 'Heroku', 'Vercel', 'Netlify', 'CloudFront', 'S3', 'Lambda', 'EC2',
        // Mobile
        'React Native', 'Flutter', 'Ionic', 'Cordova', 'Android', 'iOS', 'Objective-C', 'Mobile App Development',
        // Testing
        'Selenium', 'Testing', 'Manual Testing', 'Automation', 'QA', 'Cypress', 'Jest', 'Mocha', 'Chai', 'JUnit', 'Appium', 'Postman',
        // Data & BI
        'Machine Learning', 'AI', 'Data Science', 'Deep Learning', 'Tableau', 'Power BI', 'Excel', 'Pandas', 'NumPy', 'Scikit-learn',
        'PyTorch', 'TensorFlow', 'Keras', 'Big Data', 'Hadoop', 'Spark', 'SQL', 'NoSQL', 'Data Analytics',
        // Security
        'Cybersecurity', 'Ethical Hacking', 'Pentesting', 'Information Security', 'OAuth', 'JWT', 'SSL', 'Cryptography', 'Firewalls',
        // Design & Multimedia
        'Photoshop', 'Illustrator', 'InDesign', 'Canva', 'Sketch', 'Premiere Pro', 'After Effects', 'Video Editing', 'Graphic Design',
        // Project Management & Tools
        'Project Management', 'Agile', 'Scrum', 'Kanban', 'Jira', 'Trello', 'Asana', 'Confluence', 'Slack', 'Monday.com',
        // Business & Management
        'Sales', 'Marketing', 'Accounting', 'Financing', 'HRMS', 'ERP', 'SAP', 'Salesforce', 'CRM', 'Copywriting', 'SEO', 'SEM', 
        'Business Analysis', 'Product Management', 'Recruitment', 'Talent Acquisition', 'Operations', 'Supply Chain',
        // Soft Skills
        'Communication', 'Leadership', 'Teamwork', 'Problem Solving', 'Time Management', 'Critical Thinking', 'Adaptability', 'Emotional Intelligence'
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
