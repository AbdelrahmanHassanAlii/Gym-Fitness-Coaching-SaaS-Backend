import type { NotificationCategory } from './notification.types';

export interface RenderedNotification {
  title: string;
  body: string;
}

export interface TemplateDefinition {
  key: string;
  version: number;
  category: NotificationCategory;
  render(locale: 'ar' | 'en'): RenderedNotification;
}

const templates: Record<string, TemplateDefinition> = {
  CHECK_IN_DUE: {
    key: 'check-in-due',
    version: 1,
    category: 'CHECK_IN',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'موعد تسجيل المتابعة', body: 'لديك متابعة مستحقة الآن.' }
        : { title: 'Check-in due', body: 'You have a check-in due now.' },
  },
  CHECK_IN_OVERDUE: {
    key: 'check-in-overdue',
    version: 1,
    category: 'CHECK_IN',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'متابعة متأخرة', body: 'لديك متابعة تجاوزت موعدها.' }
        : { title: 'Check-in overdue', body: 'A check-in is now overdue.' },
  },
  CHECK_IN_SUBMITTED: {
    key: 'check-in-submitted',
    version: 1,
    category: 'CHECK_IN',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم إرسال متابعة', body: 'أرسل المتدرب متابعة جديدة للمراجعة.' }
        : { title: 'Check-in submitted', body: 'A trainee submitted a check-in for review.' },
  },
  CHECK_IN_REVIEWED: {
    key: 'check-in-reviewed',
    version: 1,
    category: 'CHECK_IN',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تمت مراجعة المتابعة', body: 'راجع المدرب المتابعة الخاصة بك.' }
        : { title: 'Check-in reviewed', body: 'Your coach reviewed your check-in.' },
  },
  DOCUMENT_UPLOADED: {
    key: 'document-uploaded',
    version: 1,
    category: 'DOCUMENT',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم رفع مستند', body: 'تمت إضافة مستند إلى ملف التدريب.' }
        : { title: 'Document uploaded', body: 'A document was added to the coaching file.' },
  },
  WORKOUT_COMPLETED: {
    key: 'workout-completed',
    version: 1,
    category: 'WORKOUT',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم إنهاء تمرين', body: 'أكمل المتدرب تمرينا.' }
        : { title: 'Workout completed', body: 'A trainee completed a workout.' },
  },
  WORKOUT_CORRECTED: {
    key: 'workout-corrected',
    version: 1,
    category: 'WORKOUT',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم تعديل تمرين', body: 'تم تعديل سجل تمرين.' }
        : { title: 'Workout corrected', body: 'A workout record was corrected.' },
  },
  PROGRAM_ACTIVATED: {
    key: 'program-activated',
    version: 1,
    category: 'TRAINING',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم تفعيل برنامج', body: 'تم تفعيل برنامج تدريبي لك.' }
        : { title: 'Program activated', body: 'A training program was activated for you.' },
  },
  PROGRAM_UPDATED: {
    key: 'program-updated',
    version: 1,
    category: 'TRAINING',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم تحديث برنامج', body: 'تم تحديث برنامجك التدريبي.' }
        : { title: 'Program updated', body: 'Your training program was updated.' },
  },
  NUTRITION_PLAN_ACTIVATED: {
    key: 'nutrition-plan-activated',
    version: 1,
    category: 'NUTRITION',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم تفعيل خطة تغذية', body: 'تم تفعيل خطة تغذية لك.' }
        : { title: 'Nutrition plan activated', body: 'A nutrition plan was activated for you.' },
  },
  NUTRITION_PLAN_UPDATED: {
    key: 'nutrition-plan-updated',
    version: 1,
    category: 'NUTRITION',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم تحديث خطة تغذية', body: 'تم تحديث خطة التغذية الخاصة بك.' }
        : { title: 'Nutrition plan updated', body: 'Your nutrition plan was updated.' },
  },
  TRAINEE_NEEDS_REASSIGNMENT: {
    key: 'trainee-needs-reassignment',
    version: 1,
    category: 'RELATIONSHIP',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'متدرب يحتاج إلى إعادة تعيين', body: 'متدرب يحتاج إلى مدرب أساسي جديد.' }
        : { title: 'Trainee needs reassignment', body: 'A trainee needs a new primary coach.' },
  },
  PERMISSION_CHANGED: {
    key: 'permission-changed',
    version: 1,
    category: 'SECURITY',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم تغيير الصلاحيات', body: 'تم تغيير صلاحيات حسابك في مساحة عمل.' }
        : { title: 'Permissions changed', body: 'Your workspace permissions were changed.' },
  },
  SUBSCRIPTION_CHANGED: {
    key: 'subscription-changed',
    version: 1,
    category: 'SUBSCRIPTION',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تحديث الاشتراك', body: 'حدث تغيير مهم في اشتراك مساحة العمل.' }
        : { title: 'Subscription update', body: 'An important workspace subscription changed.' },
  },
  SUPPORT_SESSION_STARTED: {
    key: 'support-session-started',
    version: 1,
    category: 'SECURITY',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'بدأ وصول الدعم', body: 'بدأت جلسة دعم لمنطقة العمل.' }
        : { title: 'Support access started', body: 'A support access session started.' },
  },
  SUPPORT_SESSION_ENDED: {
    key: 'support-session-ended',
    version: 1,
    category: 'SECURITY',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'انتهى وصول الدعم', body: 'انتهت جلسة دعم لمنطقة العمل.' }
        : { title: 'Support access ended', body: 'A support access session ended.' },
  },
  SUPPORT_SESSION_REVOKED: {
    key: 'support-session-revoked',
    version: 1,
    category: 'SECURITY',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم إلغاء وصول الدعم', body: 'تم إلغاء جلسة دعم لمنطقة العمل.' }
        : { title: 'Support access revoked', body: 'A support access session was revoked.' },
  },
  SUPPORT_SESSION_EXPIRED: {
    key: 'support-session-expired',
    version: 1,
    category: 'SECURITY',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'انتهت صلاحية وصول الدعم', body: 'انتهت صلاحية جلسة دعم لمنطقة العمل.' }
        : { title: 'Support access expired', body: 'A support access session expired.' },
  },
  RETENTION_WARNING_DUE: {
    key: 'retention-warning-due',
    version: 1,
    category: 'SUBSCRIPTION',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تنبيه الاحتفاظ بالبيانات', body: 'اقترب موعد مراجعة حذف بيانات مساحة العمل.' }
        : {
            title: 'Data retention warning',
            body: 'Workspace data deletion review is approaching.',
          },
  },
  WORKSPACE_DELETION_REQUESTED: {
    key: 'workspace-deletion-requested',
    version: 1,
    category: 'SUBSCRIPTION',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'مراجعة حذف مساحة العمل', body: 'أصبحت مساحة العمل مؤهلة لمراجعة الحذف.' }
        : {
            title: 'Workspace deletion review',
            body: 'The workspace is eligible for deletion review.',
          },
  },
  WORKSPACE_DELETION_POSTPONED: {
    key: 'workspace-deletion-postponed',
    version: 1,
    category: 'SUBSCRIPTION',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم تأجيل الحذف', body: 'تم تأجيل مراجعة حذف مساحة العمل.' }
        : { title: 'Deletion postponed', body: 'Workspace deletion review was postponed.' },
  },
  WORKSPACE_DELETION_CANCELLED: {
    key: 'workspace-deletion-cancelled',
    version: 1,
    category: 'SUBSCRIPTION',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم إلغاء الحذف', body: 'تم إلغاء مراجعة حذف مساحة العمل.' }
        : { title: 'Deletion cancelled', body: 'Workspace deletion review was cancelled.' },
  },
  WORKSPACE_DELETION_APPROVED: {
    key: 'workspace-deletion-approved',
    version: 1,
    category: 'SECURITY',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'تم اعتماد حذف مساحة العمل', body: 'بدأت عملية حذف بيانات مساحة العمل.' }
        : { title: 'Workspace deletion approved', body: 'Workspace data deletion has started.' },
  },
  WORKSPACE_EXPORT_READY: {
    key: 'workspace-export-ready',
    version: 1,
    category: 'SECURITY',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'التصدير جاهز', body: 'أصبح تصدير مساحة العمل جاهزا للتنزيل.' }
        : { title: 'Export ready', body: 'Your workspace export is ready to download.' },
  },
  WORKSPACE_EXPORT_FAILED: {
    key: 'workspace-export-failed',
    version: 1,
    category: 'SECURITY',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'فشل التصدير', body: 'تعذر إنشاء تصدير مساحة العمل.' }
        : { title: 'Export failed', body: 'The workspace export could not be generated.' },
  },
  WORKSPACE_EXPORT_EXPIRED: {
    key: 'workspace-export-expired',
    version: 1,
    category: 'SECURITY',
    render: (locale) =>
      locale === 'ar'
        ? { title: 'انتهت صلاحية التصدير', body: 'انتهت صلاحية رابط تصدير مساحة العمل.' }
        : { title: 'Export expired', body: 'The workspace export has expired.' },
  },
};

export function templateFor(type: string): TemplateDefinition {
  const template = templates[type];
  if (!template) throw new Error(`No notification template registered for ${type}`);
  return template;
}

export function normalizeLocale(value: string | undefined): 'ar' | 'en' {
  return value === 'ar' ? 'ar' : 'en';
}
