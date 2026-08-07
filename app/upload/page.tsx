'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  UploadCloud,
  File as FileIcon,
  X,
  CheckCircle2,
  Sparkles,
  Info,
  Loader2,
  Plus,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchableSelect, type SearchableOption } from '@/components/searchable-select';
import { supabase } from '@/lib/supabase';
import { buildAutoTags } from '@/lib/auto-tags';
import { currentSemester, semesterOptions } from '@/lib/semesters';
import { resourceFileType } from '@/lib/upload-policy';
import { cn } from '@/lib/utils';

const fileTypesAccepted = ['PDF', 'PPT', 'DOCX', 'ZIP', 'Images', 'Excel', 'Video'];
const acceptedExtensions = ['.pdf', '.ppt', '.pptx', '.docx', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.xlsx', '.xls', '.mp4', '.webm', '.mov'];
const MAX_SIZE = 100 * 1024 * 1024; // 100 MB

interface DbUniversity {
  id: string;
  name: string;
  short: string;
  status: string;
}

interface DbCourse {
  id: string;
  university_id: string;
  code: string;
  title: string;
  status: string;
}

interface DbCategory {
  id: string;
  name: string;
}

function inferContentType(file: File) {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const types: Record<string, string> = {
    pdf: 'application/pdf', ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  };
  return types[extension] ?? 'application/octet-stream';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [accountBlockReason, setAccountBlockReason] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState('Preparing upload…');
  const [submitted, setSubmitted] = useState(false);
  const [submittedResourceId, setSubmittedResourceId] = useState('');
  const [error, setError] = useState('');

  // DB reference lists
  const [universitiesList, setUniversitiesList] = useState<DbUniversity[]>([]);
  const [coursesList, setCoursesList] = useState<DbCourse[]>([]);
  const [categoriesList, setCategoriesList] = useState<DbCategory[]>([]);
  const [universitySearch, setUniversitySearch] = useState('');
  const [courseSearch, setCourseSearch] = useState('');
  
  // Custom dialogs state
  const [showAddUniDialog, setShowAddUniDialog] = useState(false);
  const [newUniName, setNewUniName] = useState('');
  const [newUniShort, setNewUniShort] = useState('');
  const [addingUni, setAddingUni] = useState(false);

  const [showAddCourseDialog, setShowAddCourseDialog] = useState(false);
  const [newCourseCode, setNewCourseCode] = useState('');
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [addingCourse, setAddingCourse] = useState(false);

  const [form, setForm] = useState({
    title: '',
    universityId: '',
    department: '',
    courseId: '',
    courseCode: '',
    semester: currentSemester().value,
    subject: '',
    category: '',
    description: '',
    tags: '',
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Institutions in the uploader's own country, for the quick-pick chips.
  const [profileCountry, setProfileCountry] = useState('');
  const [quickPickUniversities, setQuickPickUniversities] = useState<SearchableOption[]>([]);
  // Stop overwriting the generated description once it has been edited.
  const [descriptionTouched, setDescriptionTouched] = useState(false);

  const semesterChoices = useMemo(() => semesterOptions(), []);

  // Auth gate & load initial DB lists
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/auth');
        return;
      }

      const { data: accountStatus, error: accountStatusError } = await supabase.rpc('get_my_account_status');
      if (accountStatusError) {
        setAccountBlockReason('Your account status could not be verified. Reload the page before uploading.');
        setAuthChecked(true);
        return;
      }
      if (accountStatus === 'deleted') {
        await supabase.auth.signOut({ scope: 'local' });
        router.replace('/auth?error=account_unavailable');
        return;
      }
      if (accountStatus !== 'active') {
        setAccountBlockReason('This account is suspended. Existing private data remains available, but uploads and other changes are disabled.');
        setAuthChecked(true);
        return;
      }
      setAuthChecked(true);

      const { data: categoryData, error: categoryError } = await supabase.from('categories').select('id, name').order('name').limit(250);
      if (categoryError) setError('Upload categories could not be loaded. Retry before submitting.');
      else if (categoryData) setCategoriesList(categoryData);

      // Default to where this person studies. Onboarding captured it, so the
      // common case is a form that is already correct.
      const { data: profile } = await supabase
        .from('profiles')
        .select('country, university_id')
        .eq('id', session.user.id)
        .maybeSingle();

      if (profile?.university_id) {
        setForm((previous) => ({ ...previous, universityId: profile.university_id }));
      }
      if (profile?.country) {
        setProfileCountry(profile.country);
        const { data: nearby } = await supabase.rpc('list_institutions', {
          p_country: profile.country,
          p_query: '',
          p_limit: 4,
        });
        setQuickPickUniversities(
          ((nearby ?? []) as Array<{ id: string; name: string; short: string }>).map((row) => ({
            id: row.id,
            label: row.short || row.name,
            sublabel: undefined,
          })),
        );
      }
    })();
  }, [router]);

  useEffect(() => {
    if (!authChecked) return;
    const timer = window.setTimeout(() => {
      const normalized = universitySearch.trim().replace(/[%_,()]/g, ' ');
      let lookup = supabase.from('universities').select('id, name, short, status');
      if (normalized) lookup = lookup.or(`name.ilike.%${normalized}%,short.ilike.%${normalized}%`);
      void lookup.order('name').limit(50).then(({ data, error: lookupError }) => {
        if (lookupError) setError('Universities could not be loaded. Retry your search.');
        else setUniversitiesList((data ?? []) as DbUniversity[]);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [authChecked, universitySearch]);

  // Load courses whenever selected university changes
  useEffect(() => {
    if (!form.universityId) {
      setCoursesList([]);
      return;
    }
    const timer = window.setTimeout(() => {
      const normalized = courseSearch.trim().replace(/[%_,()]/g, ' ');
      let lookup = supabase
        .from('courses')
        .select('id, university_id, code, title, status')
        .eq('university_id', form.universityId);
      if (normalized) lookup = lookup.or(`code.ilike.%${normalized}%,title.ilike.%${normalized}%`);
      void lookup.order('code').limit(50).then(({ data, error: lookupError }) => {
        if (lookupError) setError('Courses could not be loaded. Retry your search.');
        else setCoursesList((data ?? []) as DbCourse[]);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [courseSearch, form.universityId]);

  const update = (key: string, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const selectedUniversity = universitiesList.find((u) => u.id === form.universityId);
  const selectedCourse = coursesList.find((c) => c.id === form.courseId);
  const selectedCategory = categoriesList.find((c) => c.id === form.category);

  // Same derivation the server performs on finalize, shown so the uploader can
  // see what their resource will be findable by.
  const autoTagPreview = useMemo(
    () =>
      buildAutoTags({
        universityShort: selectedUniversity?.short,
        universityName: selectedUniversity?.name,
        courseCode: selectedCourse?.code ?? form.courseCode,
        courseTitle: selectedCourse?.title,
        categoryName: selectedCategory?.name,
        department: form.department,
        fileType: file ? resourceFileType(file.name) : undefined,
      }),
    [selectedUniversity, selectedCourse, selectedCategory, form.courseCode, form.department, file],
  );

  // A sentence built from what they already chose beats an empty box, which in
  // practice got filled with "Autogen" and "asdf".
  useEffect(() => {
    if (descriptionTouched) return;
    if (!selectedUniversity || !selectedCategory) return;

    const course = selectedCourse ? `${selectedCourse.code} ${selectedCourse.title}` : null;
    const sentence = [
      selectedCategory.name,
      course ? `for ${course}` : null,
      `at ${selectedUniversity.name}`,
      form.semester ? `(${form.semester})` : null,
    ]
      .filter(Boolean)
      .join(' ');

    setForm((previous) => ({ ...previous, description: `${sentence}.` }));
  }, [selectedUniversity, selectedCourse, selectedCategory, form.semester, descriptionTouched]);

  // Add custom university
  const handleAddCustomUniversity = async () => {
    if (!newUniName.trim()) return;
    setAddingUni(true);
    try {
      const shortName = newUniShort.trim() || newUniName.slice(0, 5).toUpperCase();
      const { data, error } = await supabase
        .from('universities')
        .insert({
          name: newUniName.trim(),
          short: shortName,
          country: 'Global',
          status: 'custom_pending',
        })
        .select('id, name, short, status')
        .single();

      if (error) throw error;
      if (data) {
        setUniversitiesList((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
        update('universityId', data.id);
        setNewUniName('');
        setNewUniShort('');
        setShowAddUniDialog(false);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to add university.');
    } finally {
      setAddingUni(false);
    }
  };

  // Add custom course
  const handleAddCustomCourse = async () => {
    if (!form.universityId || !newCourseCode.trim() || !newCourseTitle.trim()) return;
    setAddingCourse(true);
    try {
      const { data, error } = await supabase
        .from('courses')
        .insert({
          university_id: form.universityId,
          code: newCourseCode.trim().toUpperCase(),
          title: newCourseTitle.trim(),
          status: 'custom_pending',
        })
        .select('id, university_id, code, title, status')
        .single();

      if (error) throw error;
      if (data) {
        setCoursesList((prev) => [...prev, data]);
        update('courseId', data.id);
        update('courseCode', data.code);
        setNewCourseCode('');
        setNewCourseTitle('');
        setShowAddCourseDialog(false);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to add course.');
    } finally {
      setAddingCourse(false);
    }
  };

  const handleFileSelect = useCallback((selected: File | null) => {
    if (!selected) return;
    setError('');
    const ext = '.' + (selected.name.split('.').pop()?.toLowerCase() ?? '');
    if (!acceptedExtensions.includes(ext)) {
      setError(`Unsupported file type. Accepted: ${fileTypesAccepted.join(', ')}`);
      return;
    }
    if (selected.size > MAX_SIZE) {
      setError('File too large. Maximum size is 100 MB.');
      return;
    }
    setFile(selected);
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files[0] ?? null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Please select a file to upload.');
      return;
    }
    setError('');
    setUploading(true);
    setUploadStage('Preparing secure upload…');
    setUploadProgress(10);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/auth');
        return;
      }
      const token = session.access_token;
      const contentType = inferContentType(file);

      // 1. Get Cloudflare R2 Presigned Upload URL
      const presignedRes = await fetch('/api/upload/presigned-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
        }),
      });

      if (!presignedRes.ok) {
        const errJson = await presignedRes.json().catch(() => null);
        throw new Error(errJson?.error?.message || 'Could not prepare upload session.');
      }

      const { uploadUrl, storageKey: presignedKey, requiredHeaders } = await presignedRes.json();
      let storageKey: string = presignedKey;

      setUploadProgress(30);
      setUploadStage('Uploading file to private storage…');

      // 2. Straight to R2. This is a cross-origin PUT, so it only succeeds while
      //    the bucket's CORS policy lists this exact origin - and a blocked
      //    request never reaches a server, so it surfaces as a bare TypeError
      //    with nothing in any log. Moving to the custom domain broke uploading
      //    exactly this way. Falling back through our own origin makes the
      //    upload independent of a bucket setting no deploy can check.
      let directUploadFailed = false;
      try {
        const r2UploadRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: requiredHeaders || { 'Content-Type': contentType },
          body: file,
        });
        if (!r2UploadRes.ok) directUploadFailed = true;
      } catch {
        directUploadFailed = true;
      }

      if (directUploadFailed) {
        setUploadStage('Sending the file through StudyDock…');
        const proxyBody = new FormData();
        proxyBody.append('file', file);
        const proxyRes = await fetch('/api/upload/direct', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: proxyBody,
        });
        if (!proxyRes.ok) {
          const proxyError = await proxyRes.json().catch(() => null);
          throw new Error(proxyError?.error?.message || 'The file could not be uploaded.');
        }
        storageKey = (await proxyRes.json()).storageKey;
      }

      setUploadProgress(70);
      setUploadStage('Verifying file and finalizing metadata…');

      const finalizeRes = await fetch('/api/upload/finalize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          storageKey,
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
          title: form.title,
          description: form.description,
          universityId: form.universityId,
          // A course is optional now; send null rather than an empty string.
          courseId: form.courseId || null,
          categoryId: form.category || null,
          department: form.department,
          courseCode: form.courseCode,
          semester: form.semester,
          // subject is gone, and tags are derived server-side in finalize.
        }),
      });
      if (!finalizeRes.ok) {
        const finalizeError = await finalizeRes.json();
        throw new Error(finalizeError.error?.message || 'The uploaded file could not be finalized.');
      }
      const finalized = await finalizeRes.json();

      setUploadProgress(100);
      setUploadStage('Upload finalized and awaiting moderation.');
      setSubmittedResourceId(finalized.resourceId || '');
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const resetForm = () => {
    setSubmitted(false);
    setFile(null);
    setUploadProgress(0);
    setUploadStage('Preparing upload…');
    setSubmittedResourceId('');
    setError('');
    // Keep the institution: someone uploading twice is almost always uploading
    // for the same place. Semester returns to the current term.
    setForm((previous) => ({
      title: '',
      universityId: previous.universityId,
      department: '',
      courseId: '',
      courseCode: '',
      semester: currentSemester().value,
      subject: '',
      category: '',
      description: '',
      tags: '',
    }));
    setDescriptionTouched(false);
  };

  if (!authChecked) {
    return (
      <div className="flex min-h-[calc(100vh-5rem)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (accountBlockReason) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-2xl items-center px-4 py-12">
        <div className="w-full rounded-2xl border border-border bg-card p-8 shadow-sm">
          <h1 className="font-display text-3xl font-bold tracking-tight">Uploads unavailable</h1>
          <p className="mt-3 text-muted-foreground" role="alert">{accountBlockReason}</p>
          <Button className="mt-6" variant="outline" onClick={() => window.location.reload()}>
            Retry account check
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">Upload a Resource</h1>
        <p className="mt-2 text-muted-foreground">
          Share your study materials to Cloudflare R2 and earn XP. Powered by Gemini AI.
        </p>
      </motion.div>

      <AnimatePresence mode="wait">
        {submitted ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="mt-10 flex flex-col items-center justify-center rounded-3xl border border-border bg-card p-12 text-center shadow-soft"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 200, delay: 0.2 }}
              className="flex h-20 w-20 items-center justify-center rounded-full bg-success/10 text-success"
            >
              <CheckCircle2 className="h-10 w-10" />
            </motion.div>
            <h2 className="mt-6 font-display text-2xl font-bold">Upload complete!</h2>
            <p className="mt-2 max-w-md text-muted-foreground">
              Your file was verified in Cloudflare R2 and its resource record is awaiting moderation. Supported PDFs are queued for AI processing when Gemini is configured. You earned +50 XP.
            </p>
            <div className="mt-6 flex gap-3">
              <Button className="rounded-xl" onClick={resetForm}>Upload another</Button>
              <Button variant="outline" className="rounded-xl" asChild>
                <a href={submittedResourceId ? `/resource/${submittedResourceId}` : '/dashboard'}>
                  View upload status
                </a>
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onSubmit={handleSubmit}
            className="mt-10 space-y-8"
          >
            {/* file dropzone */}
            <div>
              <label className="mb-2 block text-sm font-semibold">File</label>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed text-center transition-all',
                  // Once a file is chosen the target only has to show what was
                  // picked, so it shrinks instead of holding a phone screen of
                  // empty space.
                  file ? 'p-4' : 'p-6 sm:p-10',
                  dragOver ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-primary/40',
                )}
              >
                {file ? (
                  <div className="flex w-full items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <FileIcon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1 text-left">
                      <div className="truncate text-sm font-semibold">{file.name}</div>
                      <div className="text-xs text-muted-foreground">{formatFileSize(file.size)} · tap to replace</div>
                    </div>
                    <button
                      type="button"
                      aria-label="Remove file"
                      onClick={(e) => { e.stopPropagation(); setFile(null); }}
                      className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <motion.div
                      animate={{ y: [0, -8, 0] }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                      className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/10 to-secondary/10 text-primary sm:h-16 sm:w-16"
                    >
                      <UploadCloud className="h-6 w-6 sm:h-8 sm:w-8" />
                    </motion.div>
                    <p className="mt-3 text-sm font-medium">Tap to choose a file</p>
                    <p className="mt-1 text-xs text-muted-foreground">or drag and drop</p>
                    <p className="mt-2 text-xs text-muted-foreground">Max 100 MB · {fileTypesAccepted.join(', ')}</p>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={acceptedExtensions.join(',')}
                  className="hidden"
                  onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
                />
              </div>
            </div>

            {/* form fields */}
            <div className="grid gap-5 rounded-3xl border border-border bg-card p-4 shadow-soft sm:p-6 md:grid-cols-2">
              <Field label="Title" required full>
                <input
                  required
                  value={form.title}
                  onChange={(e) => update('title', e.target.value)}
                  placeholder="e.g. Corporate Finance — Complete Lecture Notes"
                  className="form-input"
                />
              </Field>

              {/* Institution. One control that searches and selects, with the
                  user's own country surfaced as chips and their own school
                  preselected from their profile. */}
              <Field label="Institution" required full>
                <SearchableSelect
                  options={universitiesList.map((u) => ({
                    id: u.id,
                    label: u.name,
                    sublabel: u.short,
                    hint: u.status === 'custom_pending' ? 'pending review' : undefined,
                  }))}
                  value={form.universityId}
                  onChange={(id) => {
                    update('universityId', id);
                    update('courseId', '');
                    update('courseCode', '');
                    setCourseSearch('');
                  }}
                  onSearch={setUniversitySearch}
                  quickPicks={quickPickUniversities}
                  quickPicksLabel="Quick picks for you"
                  placeholder="Search your university or school"
                  emptyMessage="No institution found. Try a different spelling."
                  onCreate={(name) => {
                    setNewUniName(name);
                    setShowAddUniDialog(true);
                  }}
                  createLabel="Add"
                />
              </Field>

              {/* Category, mandatory and immediately after the institution. */}
              <Field label="Category" required full>
                <div className="flex flex-wrap gap-1.5">
                  {categoriesList.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => update('category', form.category === c.id ? '' : c.id)}
                      aria-pressed={form.category === c.id}
                      className={cn(
                        // Tighter than a standard control on purpose: eleven of
                        // these at full size filled five rows of a phone screen.
                        'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors sm:text-sm',
                        form.category === c.id
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card hover:border-primary/40 hover:text-primary',
                      )}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            {/* Everything below is optional. Expanded by default it added four
                more screens of scrolling to reach the upload button, so it is
                folded away and opens if the uploader wants the detail. */}
            <details className="group rounded-3xl border border-border bg-card shadow-soft">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 sm:p-6">
                <div className="min-w-0">
                  <span className="text-sm font-semibold">Add more detail</span>
                  <span className="block text-xs text-muted-foreground">
                    Course, department, semester and description - all optional
                  </span>
                </div>
                <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>

              <div className="grid gap-5 border-t border-border p-4 sm:p-6 md:grid-cols-2">
              <Field label="Course" full>
                <SearchableSelect
                  options={coursesList.map((c) => ({
                    id: c.id,
                    label: c.code,
                    sublabel: c.title,
                  }))}
                  value={form.courseId}
                  onChange={(id) => {
                    update('courseId', id);
                    const course = coursesList.find((c) => c.id === id);
                    update('courseCode', course?.code ?? '');
                  }}
                  onSearch={setCourseSearch}
                  disabled={!form.universityId}
                  placeholder={
                    form.universityId ? 'Optional - search course code or title' : 'Pick an institution first'
                  }
                  emptyMessage="No course found. You can leave this empty."
                  onCreate={
                    form.universityId
                      ? (code) => {
                          setNewCourseCode(code);
                          setShowAddCourseDialog(true);
                        }
                      : undefined
                  }
                  createLabel="Add course"
                />
              </Field>

              <Field label="Department">
                <input
                  value={form.department}
                  onChange={(e) => update('department', e.target.value)}
                  placeholder="Optional, e.g. Finance & Accounting"
                  className="form-input"
                />
              </Field>

              {/* Fixed options rather than free text: "Fall 2024" used to
                  arrive as Fall24, fall 2024 and Autumn 2024. */}
              <Field label="Semester">
                <select
                  value={form.semester}
                  onChange={(e) => update('semester', e.target.value)}
                  className="filter-select"
                >
                  <option value="">Not specific to a semester</option>
                  {semesterChoices.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.value}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Description" full>
                <textarea
                  value={form.description}
                  onChange={(e) => {
                    setDescriptionTouched(true);
                    update('description', e.target.value);
                  }}
                  placeholder="Optional - we will write one from your selections"
                  className="form-input h-24 resize-none"
                />
                {!descriptionTouched && form.description && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Written from your selections. Edit it or leave it as is.
                  </p>
                )}
              </Field>

              </div>
            </details>

            {/* Tags are derived server-side from the catalog; a free-text box
                produced fin435 / FIN 435 / Fin-435 for the same course. Shown
                only once there is something to show. */}
            {autoTagPreview.length > 0 && (
              <div className="rounded-2xl border border-border bg-card p-4">
                <p className="text-xs font-semibold text-muted-foreground">
                  Tagged automatically as
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {autoTagPreview.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* One line: this is background information, not an instruction. */}
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              PDFs are queued for an AI summary after upload. The upload succeeds either way.
            </p>

            {error && (
              <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
            )}

            {uploading && (
              <div className="rounded-2xl border border-border bg-card p-4 shadow-soft">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    {uploadStage}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{uploadProgress}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-primary to-secondary"
                    initial={{ width: '0%' }}
                    animate={{ width: `${uploadProgress}%` }}
                    transition={{ ease: 'easeOut' }}
                  />
                </div>
              </div>
            )}

            {/* Stacked on a phone: side by side, the consent line was squeezed
                into four wrapped lines beside the button. */}
            <div className="flex flex-col gap-3 sm:flex-row-reverse sm:items-center sm:justify-between">
              <Button
                type="submit"
                size="lg"
                disabled={uploading}
                className="h-12 w-full rounded-2xl bg-gradient-to-r from-primary to-secondary shadow-glow disabled:opacity-50 sm:w-auto sm:px-8"
              >
                {uploading ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                ) : (
                  <UploadCloud className="mr-2 h-5 w-5" />
                )}
                {uploading ? 'Uploading...' : 'Upload Resource'}
              </Button>
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                By uploading, you confirm you have the right to share this content.
              </p>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {/* Add Custom University Modal */}
      {showAddUniDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-glow">
            <h3 className="text-xl font-bold">Add Custom University</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              If your university is not in the list, type it below. Admins will review and merge custom entries.
            </p>
            <div className="mt-4 space-y-4">
              <div>
                <label className="text-xs font-semibold">University Full Name</label>
                <input
                  value={newUniName}
                  onChange={(e) => setNewUniName(e.target.value)}
                  placeholder="e.g. Boston University"
                  className="form-input mt-1"
                />
              </div>
              <div>
                <label className="text-xs font-semibold">Abbreviation / Short Code</label>
                <input
                  value={newUniShort}
                  onChange={(e) => setNewUniShort(e.target.value)}
                  placeholder="e.g. BU"
                  className="form-input mt-1"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setShowAddUniDialog(false)}>Cancel</Button>
              <Button onClick={handleAddCustomUniversity} disabled={addingUni || !newUniName.trim()}>
                {addingUni ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save University'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Custom Course Modal */}
      {showAddCourseDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-glow">
            <h3 className="text-xl font-bold">Add Custom Course</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a new course short code and title for this university.
            </p>
            <div className="mt-4 space-y-4">
              <div>
                <label className="text-xs font-semibold">Course Code (e.g., ACC-401, FIN-435)</label>
                <input
                  value={newCourseCode}
                  onChange={(e) => setNewCourseCode(e.target.value)}
                  placeholder="e.g. FIN-435"
                  className="form-input mt-1 uppercase"
                />
              </div>
              <div>
                <label className="text-xs font-semibold">Course Title</label>
                <input
                  value={newCourseTitle}
                  onChange={(e) => setNewCourseTitle(e.target.value)}
                  placeholder="e.g. Advanced Financial Modeling"
                  className="form-input mt-1"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setShowAddCourseDialog(false)}>Cancel</Button>
              <Button onClick={handleAddCustomCourse} disabled={addingCourse || !newCourseCode.trim() || !newCourseTitle.trim()}>
                {addingCourse ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Course'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children, required, full }: { label: string; children: React.ReactNode; required?: boolean; full?: boolean }) {
  return (
    <div className={full ? 'md:col-span-2' : ''}>
      <label className="mb-1.5 block text-sm font-semibold">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}
