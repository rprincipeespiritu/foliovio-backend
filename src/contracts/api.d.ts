export interface RegistrationResult {
  verificationRequired: true
  message: string
}

export interface Subscription {
  plan: 'free' | 'pro'
  status: 'inactive' | 'active' | 'canceled' | 'past_due' | 'revoked' | 'expired'
  provider: 'manual' | 'local' | 'legacy' | 'polar' | 'paddle' | null
  currentPeriodEnd: number
  cancelAtPeriodEnd: boolean
}

export interface AuthUser {
  id: string
  email: string
  name: string
  premium: boolean
  premiumUntil: number
  exportCount: number
  remainingFree: number
  subscription: Subscription
}
