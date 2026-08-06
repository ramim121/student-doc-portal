'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Award,
  Bookmark,
  CheckCircle2,
  FileText,
  KeyRound,
  Loader2,
  Pencil,
  Trash2,
  Upload as UploadIcon,
  UserRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchableSelect, type SearchableOption } from '@/components/searchable-select';
import { achievementDefinitions } from '@/lib/gamification';
import { allCountries, countryCodeForName, countryNameForCode } from '@/lib/countries';
import { semesterOptions } from '@/lib/semesters';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

type ProfileData = {
  id: string;
  email: string;
  fullName: string;
  avatar: string;
  hasPhoto: boolean;
  dateOfBirth: string;
  country: string;
  institutionType: string;
  universityId: string;
  universityName: string;
  points: number;
  level: number;
  uploads: number;
  downloads: number;
  badge: string;
  verified: boolean;
  memberSince: string;
};

type SavedItem = {
  id: string;
  title: string;
  fileType: string | null;
  status: string;
  downloads: number;
  views: number;
  university: string;
  courseCode: string | null;
  savedAt: string;
};

type UploadItem = {
  id: string;
  title: string;
  description: string;
  fileType: string | null;
  status: string;
  downloads: number;
  views: number;
  bookmarks: number;
  createdAt: string;
  moderationReason: string;
  courseId: string;
  categoryId: string;
  department: string;
  semester: string;
  university: string;
  courseCode: string | null;
  category: string | null;
};

type Institution = { id: string; name: string; short: string };
type Category = { id: string; name: string };
type Course = { id: string; code: string; title: string };

const STATUS_STYLE: Record<string, string> = {
  approved: 'bg-success/10 text-success',
  pending: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  rejected: 'bg-destructive/10 text-destructive',
  removed: 'bg-muted text-muted-foreground',
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold capitalize', STATUS_STYLE[status] ?? 'bg-muted text-muted-foreground')}>
      {status}
    </span>
  );
}

/**
 * Which achievements this account has earned. The definitions are static, so
 * every badge is shown with the unearned ones dimmed - hiding them would leave
 * no hint of what to aim for.
 */
function earnedAchievements(profile: ProfileData | null) {
  const earned = new Set<string>();
  if (!profile) return earned;
  if (profile.uploads >= 1) earned.add('First Upload');
  if (profile.points >= 1000) earned.add('Rising Star');
  if (profile.downloads >= 100) earned.add('Helping Hand');
  if (profile.verified) earned.add('Verified');
  if (profile.uploads >= 100) earned.add('Centurion');
  return earned;
}

export default function AccountSettingsPage() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [saves, setSaves] = useState<SavedItem[]>([]);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Profile form
  const [fullName, setFullName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [institutionType, setInstitutionType] = useState<'university' | 'high_school'>('university');
  const [universityId, setUniversityId] = useState('');
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [institutionSearch, setInstitutionSearch] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);

  // Photo
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoVersion, setPhotoVersion] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // Password
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);

  // Upload editing
  const [editing, setEditing] = useState<UploadItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('');
  const [editCourseId, setEditCourseId] = useState('');
  const [editDepartment, setEditDepartment] = useState('');
  const [editSemester, setEditSemester] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState('');

  const countries = useMemo(() => allCountries(), []);
  const semesters = useMemo(() => semesterOptions(), []);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      window.location.assign(`/auth?next=${encodeURIComponent('/account')}`);
      return;
    }
    const response = await fetch('/api/profile', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setLoadError(payload?.error?.message || 'Your profile could not be loaded.');
      setLoading(false);
      return;
    }
    const loaded = payload.profile as ProfileData;
    setProfile(loaded);
    setSaves(payload.saves ?? []);
    setUploads(payload.uploads ?? []);
    setFullName(loaded.fullName);
    setDateOfBirth(loaded.dateOfBirth || '');
    setCountryCode(countryCodeForName(loaded.country));
    if (loaded.institutionType === 'high_school') setInstitutionType('high_school');
    setUniversityId(loaded.universityId || '');
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Institution options follow the chosen country, the same way onboarding does.
  useEffect(() => {
    const countryName = countryNameForCode(countryCode);
    if (!countryName) return;
    void supabase
      .rpc('list_institutions', {
        p_country: countryName,
        p_institution_type: institutionType,
        p_query: institutionSearch,
        p_limit: 30,
      })
      .then(({ data }) => setInstitutions((data ?? []) as Institution[]));
  }, [countryCode, institutionType, institutionSearch]);

  useEffect(() => {
    void supabase
      .from('categories')
      .select('id, name')
      .order('name')
      .then(({ data }) => setCategories((data ?? []) as Category[]));
  }, []);

  // Courses in the editor are scoped to the account's institution.
  useEffect(() => {
    if (!universityId) return;
    void supabase
      .from('courses')
      .select('id, code, title')
      .eq('university_id', universityId)
      .order('code')
      .limit(200)
      .then(({ data }) => setCourses((data ?? []) as Course[]));
  }, [universityId]);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setProfileError('');
    setProfileSaved(false);
    setSavingProfile(true);
    const { error } = await supabase.rpc('update_my_profile', {
      p_full_name: fullName.trim() || null,
      p_date_of_birth: dateOfBirth || null,
      p_country: countryNameForCode(countryCode) || null,
      p_institution_type: institutionType,
      p_university_id: universityId || null,
    });
    setSavingProfile(false);
    if (error) {
      setProfileError(error.message);
      return;
    }
    setProfileSaved(true);
    await load();
  };

  const uploadPhoto = async (file: File) => {
    setPhotoBusy(true);
    setProfileError('');
    const { data: { session } } = await supabase.auth.getSession();
    const body = new FormData();
    body.append('file', file);
    const response = await fetch('/api/profile/avatar', {
      method: 'POST',
      body,
      headers: session ? { Authorization: `Bearer ${session.access_token}` } : undefined,
    });
    const payload = await response.json().catch(() => null);
    setPhotoBusy(false);
    if (!response.ok) {
      setProfileError(payload?.error?.message || 'The photo could not be uploaded.');
      return;
    }
    setPhotoVersion((value) => value + 1);
    await load();
  };

  const removePhoto = async () => {
    setPhotoBusy(true);
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch('/api/profile/avatar', {
      method: 'DELETE',
      headers: session ? { Authorization: `Bearer ${session.access_token}` } : undefined,
    });
    setPhotoBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setProfileError(payload?.error?.message || 'The photo could not be removed.');
      return;
    }
    setPhotoVersion((value) => value + 1);
    await load();
  };

  const updatePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordError('');
    setPasswordSaved(false);
    if (password.length < 8) return setPasswordError('Use a password with at least 8 characters.');
    if (password !== confirmation) return setPasswordError('The passwords do not match.');
    setPasswordBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setPasswordBusy(false);
    if (error) return setPasswordError('Your password could not be changed. Sign in again and retry.');
    setPassword('');
    setConfirmation('');
    setPasswordSaved(true);
  };

  const openEditor = (item: UploadItem) => {
    setEditing(item);
    setEditTitle(item.title);
    setEditDescription(item.description);
    setEditCategoryId(item.categoryId);
    setEditCourseId(item.courseId);
    setEditDepartment(item.department);
    setEditSemester(item.semester);
    setEditError('');
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSavingEdit(true);
    setEditError('');
    const { error } = await supabase.rpc('update_my_resource', {
      p_resource_id: editing.id,
      p_title: editTitle.trim(),
      p_description: editDescription.trim() || null,
      p_course_id: editCourseId || null,
      p_category_id: editCategoryId || null,
      p_department: editDepartment.trim() || null,
      p_semester: editSemester || null,
    });
    setSavingEdit(false);
    if (error) {
      setEditError(error.message);
      return;
    }
    setEditing(null);
    await load();
  };

  const achievements = earnedAchievements(profile);
  const initials = (profile?.avatar || profile?.fullName?.slice(0, 2) || profile?.email?.slice(0, 2) || 'SD').toUpperCase();

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 pb-20 pt-24 sm:pt-28">
      {loadError && (
        <p role="alert" className="mb-6 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{loadError}</p>
      )}

      {/* Identity header */}
      <section className="glass-strong rounded-3xl p-6 shadow-glass sm:p-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="shrink-0">
            {profile?.hasPhoto ? (
              // Plain <img>: the route streams bytes from private storage, which
              // the image optimiser cannot fetch on its own.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/profile/${profile.id}/avatar?v=${photoVersion}`}
                alt="Your profile photo"
                className="h-20 w-20 rounded-2xl bg-card object-cover shadow-lg"
              />
            ) : (
              <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-secondary text-2xl font-bold text-white shadow-lg">
                {initials}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl font-bold">
              {profile?.fullName || <span className="text-muted-foreground">Add your name</span>}
            </h1>
            <p className="text-sm text-muted-foreground">{profile?.email}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-primary/10 px-2.5 py-1 font-semibold text-primary">{profile?.badge}</span>
              <span className="text-muted-foreground">Level {profile?.level}</span>
              <span className="text-muted-foreground">{profile?.points} points</span>
              {profile?.universityName && <span className="text-muted-foreground">{profile.universityName}</span>}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so picking the same file twice still fires.
                event.target.value = '';
                if (file) void uploadPhoto(file);
              }}
            />
            <Button variant="outline" size="sm" className="rounded-xl" disabled={photoBusy} onClick={() => fileInput.current?.click()}>
              {photoBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <UploadIcon className="mr-1.5 h-4 w-4" />}
              {profile?.hasPhoto ? 'Replace photo' : 'Add photo'}
            </Button>
            {profile?.hasPhoto && (
              <Button variant="ghost" size="sm" className="rounded-xl text-destructive" disabled={photoBusy} onClick={() => void removePhoto()}>
                <Trash2 className="mr-1.5 h-4 w-4" />Remove
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Profile details */}
      <section className="glass-strong mt-6 rounded-3xl p-6 shadow-glass sm:p-8">
        <div className="flex items-center gap-3">
          <UserRound className="h-5 w-5 text-primary" />
          <h2 className="font-display text-lg font-bold">Profile details</h2>
        </div>
        <form onSubmit={saveProfile} className="mt-6 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold">
              Full name
              <input className="form-input mt-1.5" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Your name" maxLength={80} />
            </label>
            <label className="block text-sm font-semibold">
              Date of birth
              <input className="form-input mt-1.5" type="date" value={dateOfBirth} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setDateOfBirth(event.target.value)} />
            </label>
          </div>

          <label className="block text-sm font-semibold">
            Country
            <select className="filter-select mt-1.5 w-full" value={countryCode} onChange={(event) => { setCountryCode(event.target.value); setUniversityId(''); }}>
              <option value="">Select your country</option>
              {countries.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
            </select>
          </label>

          <div>
            <span className="mb-1.5 block text-sm font-semibold">You are currently in</span>
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-background p-1">
              {(['university', 'high_school'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => { setInstitutionType(value); setUniversityId(''); }}
                  aria-pressed={institutionType === value}
                  className={cn('rounded-lg px-3 py-2 text-sm font-medium transition-all', institutionType === value ? 'bg-primary/10 text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                >
                  {value === 'university' ? 'University' : 'High School'}
                </button>
              ))}
            </div>
          </div>

          {countryCode && (
            <div>
              <span className="mb-1.5 block text-sm font-semibold">Institution</span>
              <SearchableSelect
                options={institutions.map((row): SearchableOption => ({ id: row.id, label: row.name, sublabel: row.short }))}
                value={universityId}
                onChange={setUniversityId}
                onSearch={setInstitutionSearch}
                placeholder="Search your institution"
                emptyMessage="No institutions found for that country yet."
              />
            </div>
          )}

          {profileError && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{profileError}</p>}
          {profileSaved && <p role="status" className="flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success"><CheckCircle2 className="h-4 w-4" />Profile updated.</p>}
          <Button type="submit" disabled={savingProfile} className="rounded-xl">
            {savingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save profile'}
          </Button>
        </form>
      </section>

      {/* Badges */}
      <section className="glass-strong mt-6 rounded-3xl p-6 shadow-glass sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <Award className="h-5 w-5 text-primary" />
          <h2 className="font-display text-lg font-bold">Badges</h2>
          <span className="text-sm text-muted-foreground">{achievements.size} of {achievementDefinitions.length} earned</span>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {achievementDefinitions.map((achievement) => {
            const earned = achievements.has(achievement.name);
            return (
              <div key={achievement.name} className={cn('rounded-2xl border p-4 transition', earned ? 'border-primary/30 bg-primary/5' : 'border-border opacity-55')}>
                <div className={cn('flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br text-white', achievement.color)}>
                  <Award className="h-4 w-4" />
                </div>
                <p className="mt-2.5 text-sm font-semibold">{achievement.name}</p>
                <p className="text-xs text-muted-foreground">{achievement.description}</p>
                {!earned && <p className="mt-1 text-[11px] font-medium text-muted-foreground">Not earned yet</p>}
              </div>
            );
          })}
        </div>
      </section>

      {/* Saved */}
      <section className="glass-strong mt-6 rounded-3xl p-6 shadow-glass sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <Bookmark className="h-5 w-5 text-primary" />
          <h2 className="font-display text-lg font-bold">My saves</h2>
          <span className="text-sm text-muted-foreground">{saves.length}</span>
        </div>
        {saves.length === 0 ? (
          <p className="mt-5 text-sm text-muted-foreground">
            Nothing saved yet. Tap the bookmark on any document and it appears here.
          </p>
        ) : (
          <ul className="mt-5 divide-y divide-border">
            {saves.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <Link href={`/resource/${item.id}`} className="font-medium hover:text-primary">{item.title}</Link>
                  <p className="text-xs text-muted-foreground">
                    {item.courseCode ? `${item.courseCode} · ` : ''}{item.university} · {item.views} views · {item.downloads} downloads
                  </p>
                </div>
                <StatusPill status={item.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Uploads */}
      <section className="glass-strong mt-6 rounded-3xl p-6 shadow-glass sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <FileText className="h-5 w-5 text-primary" />
          <h2 className="font-display text-lg font-bold">My uploads</h2>
          <span className="text-sm text-muted-foreground">{uploads.length}</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Editing a document sends it back for admin approval before it is public again.
        </p>
        {uploads.length === 0 ? (
          <p className="mt-5 text-sm text-muted-foreground">
            You have not uploaded anything yet. <Link href="/upload" className="font-semibold text-primary hover:underline">Upload a document</Link>.
          </p>
        ) : (
          <ul className="mt-5 divide-y divide-border">
            {uploads.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <Link href={`/resource/${item.id}`} className="font-medium hover:text-primary">{item.title}</Link>
                  <p className="text-xs text-muted-foreground">
                    {item.courseCode ? `${item.courseCode} · ` : ''}{item.category ?? 'Uncategorised'} · {item.views} views · {item.downloads} downloads
                  </p>
                  {item.status === 'rejected' && item.moderationReason && (
                    <p className="mt-1 text-xs text-destructive">Moderator: {item.moderationReason}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusPill status={item.status} />
                  {item.status !== 'removed' && (
                    <Button variant="outline" size="sm" className="rounded-xl" onClick={() => openEditor(item)}>
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />Edit
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Password */}
      <section className="glass-strong mt-6 rounded-3xl p-6 shadow-glass sm:p-8">
        <div className="flex items-center gap-3">
          <KeyRound className="h-5 w-5 text-primary" />
          <h2 className="font-display text-lg font-bold">Password</h2>
        </div>
        <form onSubmit={updatePassword} className="mt-6 max-w-md space-y-4">
          <label className="block text-sm font-semibold">New password<input className="form-input mt-1.5" type="password" minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          <label className="block text-sm font-semibold">Confirm new password<input className="form-input mt-1.5" type="password" minLength={8} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>
          {passwordError && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{passwordError}</p>}
          {passwordSaved && <p role="status" className="flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success"><CheckCircle2 className="h-4 w-4" />Password changed successfully.</p>}
          <Button type="submit" disabled={passwordBusy} className="rounded-xl">{passwordBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Change password'}</Button>
        </form>
      </section>

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
          <div className="my-8 w-full max-w-lg rounded-3xl border border-border bg-card p-6 shadow-glass">
            <h3 className="font-display text-lg font-bold">Edit document</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Saving returns this to the moderation queue until an admin approves it.
            </p>
            <div className="mt-5 space-y-4">
              <label className="block text-sm font-semibold">
                Title
                <input className="form-input mt-1.5" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={200} />
              </label>
              <label className="block text-sm font-semibold">
                Category
                <select className="filter-select mt-1.5 w-full" value={editCategoryId} onChange={(event) => setEditCategoryId(event.target.value)}>
                  <option value="">No category</option>
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
              </label>
              <label className="block text-sm font-semibold">
                Course
                <select className="filter-select mt-1.5 w-full" value={editCourseId} onChange={(event) => setEditCourseId(event.target.value)}>
                  <option value="">No course</option>
                  {courses.map((course) => <option key={course.id} value={course.id}>{course.code} — {course.title}</option>)}
                </select>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-semibold">
                  Department
                  <input className="form-input mt-1.5" value={editDepartment} onChange={(event) => setEditDepartment(event.target.value)} placeholder="Optional" />
                </label>
                <label className="block text-sm font-semibold">
                  Semester
                  <select className="filter-select mt-1.5 w-full" value={editSemester} onChange={(event) => setEditSemester(event.target.value)}>
                    <option value="">Not specific to a semester</option>
                    {semesters.map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
                  </select>
                </label>
              </div>
              <label className="block text-sm font-semibold">
                Description
                <textarea className="form-input mt-1.5 min-h-24" value={editDescription} onChange={(event) => setEditDescription(event.target.value)} placeholder="Optional" />
              </label>
              {editError && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{editError}</p>}
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="ghost" className="rounded-xl" onClick={() => setEditing(null)}>Cancel</Button>
              <Button className="rounded-xl" disabled={savingEdit || editTitle.trim().length < 3} onClick={() => void saveEdit()}>
                {savingEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save and resubmit'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
