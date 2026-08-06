export type FileType = 'pdf' | 'ppt' | 'docx' | 'zip' | 'img' | 'xlsx' | 'video';

export const FILE_TYPE_META: Record<
  FileType,
  { label: string; color: string; bg: string }
> = {
  pdf: { label: 'PDF', color: 'text-red-600', bg: 'bg-red-50 dark:bg-red-500/10' },
  ppt: { label: 'PPT', color: 'text-orange-600', bg: 'bg-orange-50 dark:bg-orange-500/10' },
  docx: { label: 'DOCX', color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-500/10' },
  zip: { label: 'ZIP', color: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-500/10' },
  img: { label: 'IMG', color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-500/10' },
  xlsx: { label: 'XLSX', color: 'text-green-600', bg: 'bg-green-50 dark:bg-green-500/10' },
  video: { label: 'VIDEO', color: 'text-purple-600', bg: 'bg-purple-50 dark:bg-purple-500/10' },
};

export type Resource = {
  id: string;
  title: string;
  description: string;
  university: string;
  universityShort: string;
  department: string;
  courseCode: string;
  courseTitle?: string;
  semester: string;
  subject: string;
  fileType: FileType;
  fileSize: string;
  sizeBytes?: number | null;
  pages?: number;
  uploader: string;
  uploaderAvatar: string;
  uploaderVerified: boolean;
  rating: number;
  ratingCount: number;
  downloads: number;
  views: number;
  bookmarks: number;
  comments: number;
  tags: string[];
  uploadDate: string;
  trending: boolean;
  featured: boolean;
  premium: boolean;
  category: string;
  categoryName?: string;
  aiSummary?: string | null;
  aiTopics?: string[];
  aiStatus?: 'not_requested' | 'queued' | 'processing' | 'completed' | 'failed';
};

export type CatalogOption = {
  id: string;
  name: string;
};

export type UniversityOption = CatalogOption & {
  short: string;
};

export type CourseOption = CatalogOption & {
  code: string;
  universityId: string;
};

export type CatalogOptions = {
  universities: UniversityOption[];
  courses: CourseOption[];
  categories: CatalogOption[];
};

export type ResourceSearchResponse = {
  resources: Resource[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  requestId: string;
};

export type UniversitySummary = {
  id: string;
  name: string;
  short: string;
  country: string;
  resources: number;
  contributors: number;
  departments: number;
  color: string;
  /**
   * Whether a logo exists at /api/universities/<id>/logo. Only the flag crosses
   * the wire - the storage key stays server-side.
   */
  hasLogo?: boolean;
};

export type UniversityDetail = UniversitySummary & {
  departments_list: string[];
  popularSubjects: string[];
};

export type PublicContributor = {
  id: string;
  name: string;
  avatar: string;
  university: string;
  points: number;
  level: number;
  uploads: number;
  downloads: number;
  badge: string;
  verified: boolean;
  rank: number;
};
