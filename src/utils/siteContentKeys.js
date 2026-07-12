// Every editable text block the public website understands, with the default
// text each page falls back to if the school hasn't customized it yet.
const CONTENT_KEYS = [
  // Home page
  ['home_hero_headline', 'Homepage Headline', 'A place where every student is known, taught, and prepared to lead.'],
  ['home_hero_subtext', 'Homepage Introduction', 'Serving students from Nursery through Grade 12, combining strong academics with the character and community every family deserves.'],
  ['home_feature1_title', 'Homepage - Feature 1 Title', 'Academic Excellence'],
  ['home_feature1_text', 'Homepage - Feature 1 Text', 'A full curriculum from Nursery through Grade 12, with dedicated teachers tracking every student\'s progress term by term.'],
  ['home_feature2_title', 'Homepage - Feature 2 Title', 'Caring, Qualified Staff'],
  ['home_feature2_text', 'Homepage - Feature 2 Text', 'Teachers and administrators who know every student by name, with regular performance reviews to keep standards high.'],
  ['home_feature3_title', 'Homepage - Feature 3 Title', 'Organized & Transparent'],
  ['home_feature3_text', 'Homepage - Feature 3 Text', 'Clear admissions steps, transparent fee structures, and a parent portal so families always know where their child stands.'],
  ['home_cta_text', 'Homepage - Call to Action Text', 'Admissions are open for Nursery through Grade 12. Reach out and our team will guide you through every step.'],
  // About page
  ['about_mission', 'Mission Statement', 'Our mission is to provide every student with a rigorous academic foundation, strong moral character, and the confidence to lead.'],
  ['about_vision', 'Vision Statement', 'To be a school our community trusts completely - known for academic excellence, disciplined care, and transparency in everything we do.'],
  ['about_value1_title', 'Core Value 1 Title', 'Excellence'],
  ['about_value1_text', 'Core Value 1 Text', 'We hold high standards in academics and conduct, and support every student in reaching them.'],
  ['about_value2_title', 'Core Value 2 Title', 'Integrity'],
  ['about_value2_text', 'Core Value 2 Text', 'Honesty and transparency guide how we teach, grade, and communicate with families.'],
  ['about_value3_title', 'Core Value 3 Title', 'Community'],
  ['about_value3_text', 'Core Value 3 Text', 'We see our students, staff, and parents as one extended family working toward the same goal.'],
  ['about_leadership_text', 'Leadership Section Text', 'Our administration and teaching staff bring years of experience in education, committed to every student\'s growth.'],
  // Academics & Admissions
  ['academics_intro', 'Academics Page Introduction', 'We follow a structured curriculum, giving every student a clear path from early childhood through senior secondary school.'],
  ['admissions_intro', 'Admissions Page Introduction', 'We welcome new students at the start of every academic year. Here\'s how the process works.'],
  // Donate page
  ['donate_intro', 'Donate Page Introduction', 'Your generosity helps us provide scholarships, better facilities, and richer learning opportunities for every student.'],
  ['donate_impact1_title', 'Donate - Impact Area 1 Title', 'Scholarships'],
  ['donate_impact1_text', 'Donate - Impact Area 1 Text', 'Help a deserving student afford tuition, uniforms, and books.'],
  ['donate_impact2_title', 'Donate - Impact Area 2 Title', 'Facilities'],
  ['donate_impact2_text', 'Donate - Impact Area 2 Text', 'Support improvements to classrooms, the library, and school grounds.'],
  ['donate_impact3_title', 'Donate - Impact Area 3 Title', 'Learning Resources'],
  ['donate_impact3_text', 'Donate - Impact Area 3 Text', 'Fund books, science equipment, and technology for our students.'],
  // Site-wide
  ['footer_tagline', 'Footer Tagline', 'Educating the next generation, one student at a time.'],
  ['facebook_url', 'Facebook Page URL (leave blank to hide)', ''],
  ['whatsapp_number', 'WhatsApp Number, with country code (leave blank to hide)', ''],
  ['instagram_url', 'Instagram Profile URL (leave blank to hide)', ''],
];

module.exports = { CONTENT_KEYS };
