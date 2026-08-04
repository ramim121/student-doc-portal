/**
 * Seeds a development STUDYDOCK database with content that exercises every
 * public surface: catalog, search, explore, universities, leaderboard,
 * dashboard, the admin moderation queue, and (optionally) real R2 downloads.
 *
 *   node scripts/seed-dev-data.mjs                 # create / refresh seed data
 *   node scripts/seed-dev-data.mjs --reset-users   # ALSO delete every existing
 *                                                  # auth user first
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.
 * If the CLOUDFLARE_R2_* values are also present, a small real PDF is generated
 * and uploaded for each seeded resource so downloads work end to end.
 *
 * Safe to re-run: users match by email, catalog rows by natural key, and
 * resources by a deterministic id derived from their seed slug.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadEnv, requireEnv } from './_env.mjs';

loadEnv();
const { NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY } =
  requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const RESET_USERS = process.argv.includes('--reset-users');

/**
 * Seed credentials never live in source. This repository is public, and these
 * accounts are real: a literal here would be a working admin password for any
 * deployed instance. Set them in .env (gitignored) to keep them stable across
 * runs; otherwise a strong random one is generated and printed once.
 */
function generatedPassword() {
  return `${randomBytes(18).toString('base64url')}!Aa9`;
}

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL?.trim() || 'superadmin@studydock.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD?.trim() || generatedPassword();
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD?.trim() || generatedPassword();
const GENERATED = !process.env.SEED_ADMIN_PASSWORD?.trim();

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const step = (message) => console.log(`\n== ${message}`);
const done = (message) => console.log(`   ${message}`);
const fail = (context, error) => {
  console.error(`\nFAILED: ${context}`);
  console.error(error?.message || error);
  if (error?.details) console.error(error.details);
  if (error?.hint) console.error(`hint: ${error.hint}`);
  process.exit(1);
};

/** Deterministic UUID from a slug, so re-running upserts instead of duplicating. */
function stableUuid(slug) {
  const digest = createHash('sha256').update(`studydock-seed:${slug}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Minimal single-page PDF writer (no dependency). Produces a valid PDF 1.4 so
// R2 downloads open, and the Gemini worker has real extractable text.
// ---------------------------------------------------------------------------
function buildPdf(title, bodyLines) {
  const esc = (value) => value.replace(/([\\()])/g, '\\$1');
  let text = 'BT\n/F1 16 Tf\n56 730 Td\n15 TL\n';
  text += `(${esc(title.slice(0, 88))}) Tj\n/F1 10 Tf\n`;
  for (const line of bodyLines) text += `T*\n(${esc(line.slice(0, 100))}) Tj\n`;
  text += 'ET\n';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}endstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ---------------------------------------------------------------------------
// Seed definitions
// ---------------------------------------------------------------------------
const COURSES = {
  SU: [
    ['CS-229', 'Machine Learning', 'Supervised and unsupervised learning, learning theory, reinforcement learning.'],
    ['CS-106B', 'Programming Abstractions', 'Abstract data types, recursion, and algorithmic analysis in C++.'],
    ['MATH-51', 'Linear Algebra and Differential Calculus', 'Vectors, matrices, eigenvalues, multivariable derivatives.'],
    ['ECON-101', 'Principles of Economics', 'Micro and macro foundations, markets, and policy.'],
    ['BIO-105', 'Genetics and Molecular Biology', 'Gene expression, inheritance, and molecular technique.'],
  ],
  MIT: [
    ['6-006', 'Introduction to Algorithms', 'Sorting, graphs, dynamic programming, and complexity.'],
    ['18-06', 'Linear Algebra', 'Column spaces, factorisation, eigenvalues, and applications.'],
    ['8-01', 'Classical Mechanics', 'Kinematics, Newtonian dynamics, energy, and momentum.'],
    ['16-100', 'Aerodynamics', 'Fluid mechanics, airfoil theory, and compressible flow.'],
    ['5-111', 'Principles of Chemical Science', 'Atomic structure, bonding, thermodynamics, kinetics.'],
  ],
  OX: [
    ['PHIL-101', 'Introduction to Logic and Reasoning', 'Propositional and predicate logic with formal proof.'],
    ['LAW-210', 'Contract Law', 'Formation, terms, breach, and remedies in English contract law.'],
    ['MED-140', 'Human Physiology', 'Cardiovascular, respiratory, renal, and neural systems.'],
    ['HIST-115', 'Modern European History', 'Revolution, industry, and conflict from 1789 to 1991.'],
    ['ECON-220', 'Macroeconomic Theory', 'Growth, monetary policy, and open-economy models.'],
  ],
  NUS: [
    ['CS-2103T', 'Software Engineering', 'Requirements, design patterns, testing, and team projects.'],
    ['BUS-1001', 'Foundations of Management', 'Organisational behaviour, strategy, and operations.'],
    ['EE-2026', 'Digital Design', 'Combinational and sequential logic, HDL, and FPGA workflow.'],
    ['LAW-1010', 'Legal Method and Research', 'Case analysis, statutory interpretation, and legal writing.'],
    ['MED-2001', 'Clinical Anatomy', 'Regional anatomy with radiological and surgical correlation.'],
  ],
  ETH: [
    ['INFK-252', 'Algorithms and Data Structures', 'Design paradigms, amortised analysis, and graph algorithms.'],
    ['MAVT-151', 'Engineering Thermodynamics', 'Laws of thermodynamics, cycles, and heat transfer.'],
    ['PHYS-101', 'General Physics I', 'Mechanics, oscillations, waves, and thermodynamics.'],
    ['ARCH-121', 'Architectural Design Studio', 'Spatial composition, materials, and design critique.'],
  ],
  IITB: [
    ['CS-101', 'Computer Programming and Utilization', 'Programming fundamentals and problem solving.'],
    ['EE-224', 'Digital Circuits', 'Boolean algebra, logic families, and sequential machines.'],
    ['ME-201', 'Solid Mechanics', 'Stress, strain, torsion, bending, and failure theories.'],
    ['CH-105', 'Organic Chemistry', 'Reaction mechanisms, stereochemistry, and synthesis.'],
  ],
};

const SUBJECTS = {
  SU: [['Computer Science', 'Machine Learning'], ['Computer Science', 'Data Structures'], ['Mathematics', 'Linear Algebra'], ['Business', 'Microeconomics'], ['Biology', 'Genetics']],
  MIT: [['Computer Science', 'Algorithms'], ['Mathematics', 'Linear Algebra'], ['Physics', 'Classical Mechanics'], ['Aerospace Engineering', 'Aerodynamics'], ['Chemistry', 'Physical Chemistry']],
  OX: [['Philosophy', 'Formal Logic'], ['Law', 'Contract Law'], ['Medicine', 'Physiology'], ['History', 'Modern Europe'], ['Economics', 'Macroeconomics']],
  NUS: [['Computer Science', 'Software Engineering'], ['Business', 'Management'], ['Engineering', 'Digital Design'], ['Law', 'Legal Research'], ['Medicine', 'Anatomy']],
  ETH: [['Computer Science', 'Algorithms'], ['Mechanical Engineering', 'Thermodynamics'], ['Physics', 'Mechanics'], ['Architecture', 'Design Studio']],
  IITB: [['Computer Science', 'Programming'], ['Electrical Engineering', 'Digital Circuits'], ['Mechanical Engineering', 'Solid Mechanics'], ['Chemical Engineering', 'Organic Chemistry']],
};

const STUDENTS = [
  { slug: 'ariadne', email: 'ariadne.chen@studydock.local', name: 'Ariadne Chen', uni: 'SU', avatar: 'AC', points: 2480, level: 9, uploads: 4, downloads: 1840, badge: 'Diamond', verified: true },
  { slug: 'tomas', email: 'tomas.ferreira@studydock.local', name: 'Tomas Ferreira', uni: 'MIT', avatar: 'TF', points: 1930, level: 7, uploads: 4, downloads: 1275, badge: 'Platinum', verified: true },
  { slug: 'priya', email: 'priya.nair@studydock.local', name: 'Priya Nair', uni: 'IITB', avatar: 'PN', points: 1460, level: 6, uploads: 4, downloads: 968, badge: 'Gold', verified: true },
  { slug: 'lars', email: 'lars.moretti@studydock.local', name: 'Lars Moretti', uni: 'ETH', avatar: 'LM', points: 890, level: 4, uploads: 4, downloads: 512, badge: 'Silver', verified: false },
  { slug: 'amara', email: 'amara.okonkwo@studydock.local', name: 'Amara Okonkwo', uni: 'OX', avatar: 'AO', points: 640, level: 3, uploads: 3, downloads: 341, badge: 'Bronze', verified: true },
  { slug: 'wei', email: 'wei.tan@studydock.local', name: 'Wei Tan', uni: 'NUS', avatar: 'WT', points: 415, level: 2, uploads: 3, downloads: 197, badge: 'Newbie', verified: false },
];

/** [slug, uniShort, courseCode, category, fileType, title, description, tags, stats] */
const RESOURCES = [
  ['su-cs229-notes', 'SU', 'CS-229', 'Lecture Notes', 'pdf', 'CS229 Complete Lecture Notes - Supervised Learning', 'Full lecture notes covering linear and logistic regression, generalised linear models, generative learning, kernels, and SVM derivations with worked margin examples.', ['machine learning', 'regression', 'svm', 'stanford'], { rating: 4.9, ratingCount: 312, downloads: 4820, views: 15300, bookmarks: 980, trending: true, featured: true, pages: 84 }],
  ['su-cs229-cheat', 'SU', 'CS-229', 'Cheat Sheets', 'pdf', 'CS229 Final Exam Cheat Sheet', 'One-page condensed reference: gradient descent variants, bias-variance decomposition, regularisation, and the full kernel trick derivation.', ['cheatsheet', 'exam', 'machine learning'], { rating: 4.7, ratingCount: 188, downloads: 3140, views: 9800, bookmarks: 720, trending: true, pages: 2 }],
  ['su-cs106b-assign', 'SU', 'CS-106B', 'Assignments', 'pdf', 'CS106B Assignment 5 - Recursive Backtracking Solutions', 'Annotated solutions for the maze, word-ladder, and sudoku backtracking problems, including complexity notes and common pitfalls.', ['c++', 'recursion', 'assignment'], { rating: 4.4, ratingCount: 96, downloads: 1580, views: 5200, bookmarks: 310, pages: 22 }],
  ['su-math51-guide', 'SU', 'MATH-51', 'Study Guides', 'pdf', 'MATH51 Midterm Study Guide - Matrices and Eigenvalues', 'Structured revision guide with 40 solved problems on row reduction, determinants, eigenvalue decomposition, and least squares.', ['linear algebra', 'midterm', 'eigenvalues'], { rating: 4.6, ratingCount: 141, downloads: 2210, views: 7100, bookmarks: 455, pages: 38 }],
  ['su-bio105-lab', 'SU', 'BIO-105', 'Lab Reports', 'docx', 'BIO105 Lab Report - PCR Amplification of the lacZ Gene', 'Complete lab report with methodology, gel electrophoresis results, and discussion of primer design and annealing temperature optimisation.', ['genetics', 'pcr', 'lab report'], { rating: 4.2, ratingCount: 58, downloads: 890, views: 3050, bookmarks: 176, pages: 14 }],

  ['mit-6006-notes', 'MIT', '6-006', 'Lecture Notes', 'pdf', '6.006 Introduction to Algorithms - Full Course Notes', 'Every lecture from asymptotic analysis through dynamic programming and shortest paths, with the recurrence-solving templates used in recitation.', ['algorithms', 'dynamic programming', 'graphs', 'mit'], { rating: 4.9, ratingCount: 402, downloads: 6150, views: 21400, bookmarks: 1340, trending: true, featured: true, pages: 112 }],
  ['mit-6006-past', 'MIT', '6-006', 'Past Papers', 'pdf', '6.006 Past Exam Papers 2019-2024 with Solutions', 'Six years of quizzes and finals, each with the official rubric and step-by-step worked solutions.', ['past papers', 'algorithms', 'exam prep'], { rating: 4.8, ratingCount: 267, downloads: 5020, views: 16800, bookmarks: 1105, trending: true, pages: 96 }],
  ['mit-1806-notes', 'MIT', '18-06', 'Lecture Notes', 'pdf', '18.06 Linear Algebra - Lecture Companion Notes', 'Lecture-by-lecture companion covering the four fundamental subspaces, LU and QR factorisation, SVD, and positive-definite matrices.', ['linear algebra', 'svd', 'factorisation'], { rating: 4.8, ratingCount: 233, downloads: 4410, views: 14200, bookmarks: 930, featured: true, pages: 74 }],
  ['mit-801-slides', 'MIT', '8-01', 'Presentations', 'ppt', '8.01 Classical Mechanics - Rotational Dynamics Deck', 'Slide deck on torque, angular momentum, and rigid-body rotation with animated worked examples from recitation.', ['physics', 'mechanics', 'rotation'], { rating: 4.3, ratingCount: 74, downloads: 1120, views: 4400, bookmarks: 208, pages: 46 }],

  ['ox-law210-case', 'OX', 'LAW-210', 'Case Analysis', 'pdf', 'Contract Law - Carlill v Carbolic Smoke Ball Analysis', 'Full case analysis covering unilateral offer, intention to create legal relations, and how the ruling shaped modern advertising law.', ['contract law', 'case analysis', 'oxford'], { rating: 4.7, ratingCount: 129, downloads: 2340, views: 8600, bookmarks: 512, trending: true, pages: 18 }],
  ['ox-phil101-notes', 'OX', 'PHIL-101', 'Lecture Notes', 'pdf', 'Introduction to Logic - Natural Deduction Notes', 'Complete natural deduction system for propositional and first-order logic, with 60 worked proofs and common error patterns.', ['logic', 'philosophy', 'proofs'], { rating: 4.5, ratingCount: 88, downloads: 1460, views: 5300, bookmarks: 289, pages: 52 }],
  ['ox-med140-guide', 'OX', 'MED-140', 'Study Guides', 'pdf', 'Human Physiology - Cardiovascular System Revision Guide', 'Cardiac cycle, pressure-volume loops, baroreceptor reflex, and Starling forces condensed for finals with clinical correlation boxes.', ['physiology', 'cardiovascular', 'medicine'], { rating: 4.6, ratingCount: 112, downloads: 1980, views: 6900, bookmarks: 407, pages: 34 }],

  ['nus-cs2103t-report', 'NUS', 'CS-2103T', 'Reports', 'pdf', 'CS2103T Team Project Report - Architecture and Testing', 'Architecture report with component diagrams, design pattern rationale, and the full testing strategy used for the team project.', ['software engineering', 'design patterns', 'uml'], { rating: 4.4, ratingCount: 91, downloads: 1670, views: 5800, bookmarks: 322, pages: 41 }],
  ['nus-ee2026-lab', 'NUS', 'EE-2026', 'Lab Reports', 'pdf', 'EE2026 Lab - FPGA Seven-Segment Display Controller', 'Verilog source walkthrough, timing analysis, and synthesis results for the seven-segment multiplexing lab.', ['fpga', 'verilog', 'digital design'], { rating: 4.1, ratingCount: 47, downloads: 720, views: 2600, bookmarks: 138, pages: 16 }],
  ['nus-bus1001-slides', 'NUS', 'BUS-1001', 'Presentations', 'ppt', 'BUS1001 - Five Forces Applied to Regional Airlines', 'Group presentation applying competitive strategy frameworks to Southeast Asian budget carriers, with a financial appendix.', ['strategy', 'management', 'case study'], { rating: 4.0, ratingCount: 39, downloads: 540, views: 2100, bookmarks: 96, pages: 28 }],

  ['eth-infk252-notes', 'ETH', 'INFK-252', 'Lecture Notes', 'pdf', 'Algorithms and Data Structures - Full Semester Notes', 'Translated lecture notes covering divide and conquer, greedy proofs, union-find, and network flow.', ['algorithms', 'data structures', 'eth'], { rating: 4.7, ratingCount: 156, downloads: 2680, views: 9100, bookmarks: 561, featured: true, pages: 88 }],
  ['eth-mavt151-guide', 'ETH', 'MAVT-151', 'Study Guides', 'pdf', 'Engineering Thermodynamics - Cycle Analysis Workbook', 'Otto, Diesel, Brayton, and Rankine cycles worked end to end with entropy tables and efficiency comparisons.', ['thermodynamics', 'cycles', 'mechanical'], { rating: 4.5, ratingCount: 83, downloads: 1290, views: 4700, bookmarks: 247, pages: 44 }],
  ['eth-arch121-img', 'ETH', 'ARCH-121', 'Presentations', 'img', 'ARCH121 Studio - Final Model Photography Board', 'High-resolution presentation board of the timber pavilion studio project, including plan, section, and material study.', ['architecture', 'studio', 'portfolio'], { rating: 4.2, ratingCount: 31, downloads: 410, views: 1900, bookmarks: 88, pages: 1 }],

  ['iitb-cs101-notes', 'IITB', 'CS-101', 'Class Notes', 'pdf', 'CS101 Programming Fundamentals - Tutorial Notes', 'Tutorial-by-tutorial notes with 90 solved programming exercises in C++, covering arrays, pointers, and file handling.', ['programming', 'c++', 'tutorial'], { rating: 4.3, ratingCount: 104, downloads: 1830, views: 6400, bookmarks: 351, pages: 66 }],
  ['iitb-ee224-past', 'IITB', 'EE-224', 'Past Papers', 'pdf', 'EE224 Digital Circuits - Endsem Papers with Solutions', 'Five years of end-semester papers on state machines, timing hazards, and memory design, each fully solved.', ['digital circuits', 'past papers', 'state machines'], { rating: 4.6, ratingCount: 137, downloads: 2410, views: 8200, bookmarks: 468, trending: true, pages: 58 }],
  ['iitb-me201-report', 'IITB', 'ME-201', 'Reports', 'xlsx', 'ME201 Solid Mechanics - Beam Deflection Calculation Sheet', 'Spreadsheet computing deflection, slope, and bending stress for standard loading cases with an editable input block.', ['solid mechanics', 'beams', 'calculator'], { rating: 4.4, ratingCount: 62, downloads: 980, views: 3400, bookmarks: 204, pages: 6 }],
  ['iitb-ch105-paper', 'IITB', 'CH-105', 'Research Papers', 'pdf', 'Selective Oxidation Pathways in Substituted Aromatics', 'Undergraduate research paper on regioselectivity in substituted aromatic oxidation, with NMR characterisation data.', ['organic chemistry', 'research', 'nmr'], { rating: 4.5, ratingCount: 44, downloads: 610, views: 2400, bookmarks: 152, pages: 27 }],
];

const AI_SUMMARIES = {
  'su-cs229-notes': ['These notes develop supervised learning from least squares through to kernel methods. They derive the normal equations, motivate logistic regression via maximum likelihood, generalise both under the exponential family, and close with the dual formulation of the support vector machine and the representer theorem.', ['supervised learning', 'logistic regression', 'kernel methods', 'support vector machines', 'exponential family'], 95],
  'mit-6006-notes': ['A complete algorithms course covering asymptotic analysis, comparison and linear-time sorting, hashing, binary search trees, graph traversal, shortest paths, and dynamic programming. Each unit pairs an invariant-based correctness argument with a recurrence-based complexity analysis.', ['asymptotic analysis', 'sorting', 'hash tables', 'graph algorithms', 'dynamic programming'], 128],
  'mit-1806-notes': ['A companion covering elimination and factorisation, the four fundamental subspaces, orthogonality and projection, determinants, eigenvalue decomposition, and the singular value decomposition, with applications to least squares and principal components.', ['matrix factorisation', 'fundamental subspaces', 'eigenvalues', 'singular value decomposition', 'least squares'], 84],
  'ox-law210-case': ['An analysis of Carlill v Carbolic Smoke Ball Co, treating the advertisement as a unilateral offer to the world, the deposit as evidence of intention to create legal relations, and performance as acceptance without communication. Considers the modern reach of the rule in consumer advertising.', ['unilateral offer', 'intention to create legal relations', 'acceptance by conduct', 'consideration'], 21],
};

// ---------------------------------------------------------------------------
step('Preflight: verifying the schema is fully migrated');
{
  const { error: coursesError } = await db.from('courses').select('id').limit(1);
  if (coursesError) {
    console.error(`   public.courses is not reachable: ${coursesError.message}`);
    console.error('   Run `node scripts/apply-migrations.mjs` first.');
    process.exit(1);
  }
  const { error: rpcError } = await db.rpc('get_my_role');
  if (rpcError?.code === 'PGRST202') {
    console.error('   RPC get_my_role is missing. Run `node scripts/apply-migrations.mjs` first.');
    process.exit(1);
  }
  done('schema looks migrated');
}

step('Loading universities and categories');
const { data: universities, error: uniError } = await db.from('universities').select('id, short, name');
if (uniError) fail('reading universities', uniError);
const uniByShort = Object.fromEntries(universities.map((u) => [u.short, u]));
done(`${universities.length} universities: ${universities.map((u) => u.short).join(', ')}`);

const { data: categories, error: catError } = await db.from('categories').select('id, name');
if (catError) fail('reading categories', catError);
const catByName = Object.fromEntries(categories.map((c) => [c.name, c.id]));
done(`${categories.length} categories`);

for (const short of Object.keys(COURSES)) {
  if (!uniByShort[short]) fail('seed definition', new Error(`University "${short}" is missing from the database.`));
}

{
  const { error } = await db.from('universities').update({ status: 'official' }).in('short', Object.keys(COURSES));
  if (error) fail('marking universities official', error);
  done('seeded universities set to status=official');
}

// ---------------------------------------------------------------------------
step('Auth users');
const { data: existing, error: listError } = await db.auth.admin.listUsers({ perPage: 1000 });
if (listError) fail('listing auth users', listError);

if (existing.users.length) {
  console.log(`   ${existing.users.length} existing user(s):`);
  for (const user of existing.users) {
    console.log(`     - ${user.email || '(no email)'}  id=${user.id}  created=${user.created_at}`);
  }
} else {
  done('no existing users');
}

if (RESET_USERS && existing.users.length) {
  console.log('   --reset-users given: deleting all of the above');
  for (const user of existing.users) {
    const { error } = await db.auth.admin.deleteUser(user.id);
    if (error) fail(`deleting user ${user.id}`, error);
    console.log(`     deleted ${user.email || user.id}`);
  }
} else if (existing.users.length) {
  done('kept (pass --reset-users to delete them)');
}

const { data: afterReset } = await db.auth.admin.listUsers({ perPage: 1000 });
const byEmail = new Map((afterReset?.users ?? []).map((u) => [u.email?.toLowerCase(), u]));

async function ensureUser(email, password, fullName) {
  const found = byEmail.get(email.toLowerCase());
  if (found) {
    const { error } = await db.auth.admin.updateUserById(found.id, {
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) fail(`updating ${email}`, error);
    return found.id;
  }
  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) fail(`creating ${email}`, error);
  return data.user.id;
}

const adminId = await ensureUser(ADMIN_EMAIL, ADMIN_PASSWORD, 'STUDYDOCK Super Admin');
done(`superadmin ${ADMIN_EMAIL}`);

const studentIds = {};
for (const student of STUDENTS) {
  studentIds[student.slug] = await ensureUser(student.email, DEMO_PASSWORD, student.name);
  done(`student   ${student.email}`);
}

// The handle_new_user trigger creates each profile row; fill in the rest.
step('Profiles');
{
  const { error } = await db.from('profiles').update({
    full_name: 'STUDYDOCK Super Admin',
    avatar: 'SA',
    role: 'admin',
    account_status: 'active',
    verified: true,
    badge: 'Diamond',
  }).eq('id', adminId);
  if (error) fail('promoting the superadmin profile', error);
  done('superadmin promoted to role=admin');
}

for (const student of STUDENTS) {
  const { error } = await db.from('profiles').update({
    full_name: student.name,
    avatar: student.avatar,
    role: 'user',
    account_status: 'active',
    university_id: uniByShort[student.uni].id,
    points: student.points,
    level: student.level,
    uploads: student.uploads,
    downloads: student.downloads,
    badge: student.badge,
    verified: student.verified,
  }).eq('id', studentIds[student.slug]);
  if (error) fail(`updating the profile for ${student.email}`, error);
}
done(`${STUDENTS.length} student profiles populated`);

// ---------------------------------------------------------------------------
step('Subjects');
{
  const { data: current, error } = await db.from('subjects').select('university_id, department, name');
  if (error) fail('reading subjects', error);
  const seen = new Set((current ?? []).map((s) => `${s.university_id}|${s.department}|${s.name}`));
  const rows = [];
  for (const [short, entries] of Object.entries(SUBJECTS)) {
    for (const [department, name] of entries) {
      const key = `${uniByShort[short].id}|${department}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ university_id: uniByShort[short].id, department, name });
    }
  }
  if (rows.length) {
    const { error: insertError } = await db.from('subjects').insert(rows);
    if (insertError) fail('inserting subjects', insertError);
  }
  done(`${rows.length} inserted, ${seen.size} total`);
}

step('Courses');
const courseByKey = {};
{
  const rows = [];
  for (const [short, entries] of Object.entries(COURSES)) {
    for (const [code, title, description] of entries) {
      rows.push({ university_id: uniByShort[short].id, code, title, description, status: 'official' });
    }
  }
  const { error } = await db.from('courses').upsert(rows, { onConflict: 'university_id,code' });
  if (error) fail('upserting courses', error);

  const { data: stored, error: readError } = await db.from('courses').select('id, university_id, code, title');
  if (readError) fail('reading courses', readError);
  for (const course of stored) courseByKey[`${course.university_id}|${course.code}`] = course;
  done(`${rows.length} upserted, ${stored.length} total`);
}

// ---------------------------------------------------------------------------
step('Cloudflare R2');
const r2Ready = ['CLOUDFLARE_R2_ACCOUNT_ID', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_R2_BUCKET_NAME']
  .every((key) => process.env[key]?.trim());
let s3 = null;
let bucket = null;

if (r2Ready) {
  bucket = process.env.CLOUDFLARE_R2_BUCKET_NAME.trim();
  s3 = new S3Client({
    region: 'auto',
    endpoint:
      process.env.CLOUDFLARE_R2_ENDPOINT?.trim() ||
      `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID.trim(),
      secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY.trim(),
    },
  });
  done(`configured, bucket "${bucket}" - placeholder PDFs will be uploaded`);
} else {
  done('not configured - resources are seeded without stored files.');
  done('Downloads return RESOURCE_FILE_UNAVAILABLE until R2 is set up, then re-run this script.');
}

// ---------------------------------------------------------------------------
step('Resources');
const uploaderOrder = STUDENTS.map((student) => student.slug);
const resourceRows = [];
let uploadedCount = 0;

for (const [index, entry] of RESOURCES.entries()) {
  const [slug, short, courseCode, categoryName, fileType, title, description, tags, stats] = entry;
  const university = uniByShort[short];
  const course = courseByKey[`${university.id}|${courseCode}`];
  if (!course) fail('resource seed', new Error(`Course ${short}/${courseCode} was not found.`));
  const categoryId = catByName[categoryName];
  if (!categoryId) fail('resource seed', new Error(`Category "${categoryName}" was not found.`));

  const uploaderId = studentIds[uploaderOrder[index % uploaderOrder.length]];
  // Spread created_at backwards so "newest" ordering is meaningful.
  const createdAt = new Date(Date.UTC(2026, 6, 28) - index * 36 * 3600 * 1000).toISOString();
  const [department, subjectName] = SUBJECTS[short][index % SUBJECTS[short].length];

  let storageKey = null;
  let sizeBytes = null;
  let mimeType = null;
  let checksum = null;
  let fileSize = null;
  const originalFileName = `${slug}.pdf`;

  if (s3) {
    const pdf = buildPdf(title, [
      '',
      `University: ${university.name}`,
      `Course:     ${course.code} - ${course.title}`,
      `Category:   ${categoryName}`,
      '',
      ...(description.match(/.{1,96}(\s|$)/g) ?? []).map((line) => line.trim()),
      '',
      'Generated STUDYDOCK development seed content. It exists so that the',
      'upload, storage, moderation, and download paths can be exercised end',
      'to end against a real Cloudflare R2 object.',
    ]);
    storageKey = `resources/${uploaderId}/${stableUuid(`${slug}-object`)}-${originalFileName}`;
    checksum = createHash('sha256').update(pdf).digest('base64');
    sizeBytes = pdf.byteLength;
    mimeType = 'application/pdf';
    fileSize = `${(sizeBytes / 1024).toFixed(1)} KB`;

    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: pdf,
        ContentType: mimeType,
        ChecksumSHA256: checksum,
      }));
      uploadedCount += 1;
    } catch (error) {
      // A broken bucket must not cost the whole seed. Fall back to
      // metadata-only rows; re-running after fixing R2 uploads and links them.
      console.warn(`   R2 upload failed (${error.name}: ${error.message})`);
      console.warn('   Continuing without stored files. Fix R2, then re-run this script.');
      s3 = null;
      storageKey = null;
      sizeBytes = null;
      mimeType = null;
      checksum = null;
      fileSize = null;
    }
  }

  const ai = AI_SUMMARIES[slug];

  resourceRows.push({
    id: stableUuid(slug),
    title,
    description,
    university_id: university.id,
    course_id: course.id,
    category_id: categoryId,
    department,
    course_code: course.code,
    semester: ['Fall 2025', 'Spring 2026', 'Summer 2026'][index % 3],
    subject: subjectName,
    file_type: fileType,
    file_size: fileSize ?? 'n/a',
    size_bytes: sizeBytes,
    mime_type: mimeType,
    original_file_name: storageKey ? originalFileName : null,
    checksum_sha256: checksum,
    uploader_id: uploaderId,
    storage_provider: 'r2',
    storage_key: storageKey,
    upload_finalized_at: storageKey ? createdAt : null,
    status: 'approved',
    moderated_at: createdAt,
    moderated_by: adminId,
    tags,
    ai_status: ai ? 'completed' : 'not_requested',
    ai_summary: ai?.[0] ?? null,
    ai_topics: ai?.[1] ?? null,
    ai_reading_time_minutes: ai?.[2] ?? null,
    rating: stats.rating,
    rating_count: stats.ratingCount,
    downloads: stats.downloads,
    views: stats.views,
    bookmarks: stats.bookmarks,
    trending: Boolean(stats.trending),
    featured: Boolean(stats.featured),
    premium: false,
    pages: stats.pages,
    created_at: createdAt,
  });
}

{
  const { error } = await db.from('resources').upsert(resourceRows, { onConflict: 'id' });
  if (error) fail('upserting resources', error);
  done(`${resourceRows.length} resources upserted (status=approved)`);
  if (s3) done(`${uploadedCount} PDF objects uploaded to R2`);
}

step('Moderation queue sample');
{
  const university = uniByShort.NUS;
  const course = courseByKey[`${university.id}|CS-2103T`];
  const { error } = await db.from('resources').upsert([{
    id: stableUuid('pending-review-sample'),
    title: 'CS2103T Draft Notes - Awaiting Moderation',
    description: 'Seeded example of a freshly finalized upload that has not been reviewed yet. Approve or reject it from the admin Resource Moderation screen to watch the lifecycle work.',
    university_id: university.id,
    course_id: course.id,
    category_id: catByName['Class Notes'],
    department: 'Computer Science',
    course_code: course.code,
    semester: 'Spring 2026',
    subject: 'Software Engineering',
    file_type: 'pdf',
    file_size: 'n/a',
    uploader_id: studentIds.wei,
    storage_provider: 'r2',
    storage_key: null,
    status: 'pending',
    tags: ['draft', 'pending review'],
    ai_status: 'not_requested',
    rating: 0,
    rating_count: 0,
    downloads: 0,
    views: 3,
    bookmarks: 0,
    trending: false,
    featured: false,
    premium: false,
    created_at: new Date(Date.UTC(2026, 6, 30)).toISOString(),
  }], { onConflict: 'id' });
  if (error) fail('seeding the pending resource', error);
  done('1 pending resource for the admin queue');
}

// ---------------------------------------------------------------------------
step('Verification');
for (const [label, query] of [
  ['official universities', db.from('universities').select('id', { count: 'exact', head: true }).eq('status', 'official')],
  ['courses', db.from('courses').select('id', { count: 'exact', head: true })],
  ['subjects', db.from('subjects').select('id', { count: 'exact', head: true })],
  ['approved resources', db.from('resources').select('id', { count: 'exact', head: true }).eq('status', 'approved')],
  ['pending resources', db.from('resources').select('id', { count: 'exact', head: true }).eq('status', 'pending')],
  ['profiles', db.from('profiles').select('id', { count: 'exact', head: true })],
  ['admins', db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin')],
]) {
  const { count, error } = await query;
  if (error) fail(`counting ${label}`, error);
  console.log(`   ${String(count).padStart(4)}  ${label}`);
}

console.log(`
============================================================
  SEED COMPLETE
============================================================

  ADMIN APP   http://localhost:3001
    email     ${ADMIN_EMAIL}
    password  ${ADMIN_PASSWORD}

  PORTAL      http://localhost:3000
    email     ${STUDENTS[0].email}
    password  ${DEMO_PASSWORD}
    (all ${STUDENTS.length} demo students share this password)

${GENERATED ? `  These were generated randomly and are shown ONCE. Record them now, or
  set SEED_ADMIN_PASSWORD / SEED_DEMO_PASSWORD in .env to pin them.` : '  Loaded from .env (SEED_ADMIN_PASSWORD / SEED_DEMO_PASSWORD).'}

  Change the admin password after first sign-in:
  Supabase Dashboard > Authentication > Users.
============================================================
`);
