import type { NotificationCategory, NotificationChannel } from './notification.types';

export interface NotificationRegistryEntry {
  eventType: string;
  notificationType: string;
  category: NotificationCategory;
  channels: NotificationChannel[];
  mandatory: boolean;
  stalePolicy: 'FACT' | 'CHECK_IN_STATUS';
}

export const notificationRegistry: NotificationRegistryEntry[] = [
  {
    eventType: 'CheckInDue',
    notificationType: 'CHECK_IN_DUE',
    category: 'CHECK_IN',
    channels: ['IN_APP', 'EMAIL', 'PUSH'],
    mandatory: false,
    stalePolicy: 'CHECK_IN_STATUS',
  },
  {
    eventType: 'CheckInOverdue',
    notificationType: 'CHECK_IN_OVERDUE',
    category: 'CHECK_IN',
    channels: ['IN_APP', 'EMAIL', 'PUSH'],
    mandatory: false,
    stalePolicy: 'CHECK_IN_STATUS',
  },
  {
    eventType: 'CheckInSubmitted',
    notificationType: 'CHECK_IN_SUBMITTED',
    category: 'CHECK_IN',
    channels: ['IN_APP', 'EMAIL', 'PUSH'],
    mandatory: false,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'CheckInReviewed',
    notificationType: 'CHECK_IN_REVIEWED',
    category: 'CHECK_IN',
    channels: ['IN_APP', 'EMAIL', 'PUSH'],
    mandatory: false,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'DocumentUploaded',
    notificationType: 'DOCUMENT_UPLOADED',
    category: 'DOCUMENT',
    channels: ['IN_APP', 'EMAIL', 'PUSH'],
    mandatory: false,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'WorkoutCompleted',
    notificationType: 'WORKOUT_COMPLETED',
    category: 'WORKOUT',
    channels: ['IN_APP', 'PUSH'],
    mandatory: false,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'WorkoutCorrected',
    notificationType: 'WORKOUT_CORRECTED',
    category: 'WORKOUT',
    channels: ['IN_APP'],
    mandatory: false,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'ProgramActivated',
    notificationType: 'PROGRAM_ACTIVATED',
    category: 'TRAINING',
    channels: ['IN_APP', 'EMAIL', 'PUSH'],
    mandatory: false,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'ProgramUpdated',
    notificationType: 'PROGRAM_UPDATED',
    category: 'TRAINING',
    channels: ['IN_APP', 'PUSH'],
    mandatory: false,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'NutritionPlanActivated',
    notificationType: 'NUTRITION_PLAN_ACTIVATED',
    category: 'NUTRITION',
    channels: ['IN_APP', 'EMAIL', 'PUSH'],
    mandatory: false,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'NutritionPlanUpdated',
    notificationType: 'NUTRITION_PLAN_UPDATED',
    category: 'NUTRITION',
    channels: ['IN_APP', 'PUSH'],
    mandatory: false,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'TraineeNeedsReassignment',
    notificationType: 'TRAINEE_NEEDS_REASSIGNMENT',
    category: 'RELATIONSHIP',
    channels: ['IN_APP', 'EMAIL'],
    mandatory: false,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'MembershipPermissionProfilesReplaced',
    notificationType: 'PERMISSION_CHANGED',
    category: 'SECURITY',
    channels: ['IN_APP', 'EMAIL'],
    mandatory: true,
    stalePolicy: 'FACT',
  },
  {
    eventType: 'SubscriptionFrozen',
    notificationType: 'SUBSCRIPTION_CHANGED',
    category: 'SUBSCRIPTION',
    channels: ['IN_APP', 'EMAIL'],
    mandatory: true,
    stalePolicy: 'FACT',
  },
];

export function registeredEventTypes(): string[] {
  return [...new Set(notificationRegistry.map((entry) => entry.eventType))];
}

export function entriesForEvent(eventType: string): NotificationRegistryEntry[] {
  return notificationRegistry.filter((entry) => entry.eventType === eventType);
}
