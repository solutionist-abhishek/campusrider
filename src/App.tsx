import { lazy, Suspense, useEffect, useEffectEvent, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bike,
  Check,
  ChevronDown,
  CircleHelp,
  Compass,
  LoaderCircle,
  MapPinned,
  Minus,
  PackageCheck,
  Plus,
  Search,
  ShoppingBag,
  LockKeyhole,
  LogOut,
  Mail,
  MapPin,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import './App.css'

const PickupWorkspace = lazy(() => import('./PickupWorkspace'))

type Screen = 'welcome' | 'auth' | 'reset' | 'dashboard'
type AuthTab = 'login' | 'signup'
type WorkspaceTab = 'pickup' | 'order' | 'deliver'
type MenuCategory = 'All' | 'Food' | 'Drinks' | 'Other'

type Canteen = {
  id: string
  name: string
  description: string
  location: string
  is_active: boolean
}

type Product = {
  id: string
  canteen_id: string
  name: string
  description: string
  category: MenuCategory
  price: number
  image_url: string | null
  is_available: boolean
}

type OrderRow = {
  id: string
  canteen_id: string | null
  status: string
  total_amount: number
  created_at: string
  delivery_location: string
  order_items: { product_name: string; quantity: number; unit_price: number }[]
}

type Delivery = {
  id: string
  order_id: string
  pickup_location: string
  destination: string
  status?: string
  created_at: string
  completed_at?: string
  items?: { name: string; quantity: number }[]
}

type LedgerEntry = {
  id: string
  delivery_id: string
  amount: number | null
  status: 'pending_configuration' | 'recorded' | 'paid'
  created_at: string
}

type DeliveryWorkspace = {
  is_online: boolean
  compensation_configured: boolean
  available: Delivery[]
  active: Delivery[]
  completed: Delivery[]
  earnings: LedgerEntry[]
  total_earnings: number
}

const officialEmailError = 'Please use your official NIT Srinagar email address ending in @nitsri.ac.in.'

function normalizedEmail(value: string) {
  return value.trim().toLowerCase()
}

function isOfficialEmail(value: string) {
  return /^[^\s@]+@nitsri\.ac\.in$/i.test(value.trim())
}

function passwordIsStrong(value: string) {
  return value.length >= 12 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value)
}

function isDevBypassEnabled() {
  return import.meta.env.DEV && import.meta.env.VITE_DEV_BYPASS_AUTH === 'true'
}

function createPreviewSession(): Session {
  return {
    access_token: 'preview-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
    refresh_token: 'preview-refresh-token',
    user: {
      id: 'preview-user',
      email: 'preview@student.nitsri.ac.in',
      app_metadata: { provider: 'demo', providers: ['demo'] },
      user_metadata: { full_name: 'Campus Rider Preview' },
      aud: 'authenticated',
      created_at: new Date().toISOString(),
      role: 'authenticated',
    },
  } as Session
}

function getPreviewDashboardData() {
  return {
    canteens: [
      { id: 'canteen-base', name: 'Main Canteen', description: 'Fast meals and campus essentials.', location: 'Main Campus', is_active: true },
      { id: 'canteen-hostel', name: 'Hostel Kitchen', description: 'Late-night snacks and student favorites.', location: 'Hostel Block C', is_active: true },
      { id: 'canteen-juice', name: 'Juice Corner', description: 'Fresh drinks and quick bites.', location: 'Library Road', is_active: true },
    ],
    products: [
      { id: 'p-1', canteen_id: 'canteen-base', name: 'Veg Thali', description: 'Rice, sabzi, dal, salad, and chapati.', category: 'Food', price: 90, image_url: null, is_available: true },
      { id: 'p-2', canteen_id: 'canteen-base', name: 'Paneer Roll', description: 'Warm roll with paneer and sauces.', category: 'Food', price: 65, image_url: null, is_available: true },
      { id: 'p-3', canteen_id: 'canteen-hostel', name: 'Masala Maggi', description: 'Classic instant noodles with extra veggies.', category: 'Food', price: 45, image_url: null, is_available: true },
      { id: 'p-4', canteen_id: 'canteen-juice', name: 'Mango Shake', description: 'Fresh mango shake with chilled milk.', category: 'Drinks', price: 60, image_url: null, is_available: true },
      { id: 'p-5', canteen_id: 'canteen-juice', name: 'Coconut Water', description: 'Freshly chilled coconut water.', category: 'Drinks', price: 45, image_url: null, is_available: true },
      { id: 'p-6', canteen_id: 'canteen-base', name: 'Fruit Bowl', description: 'Seasonal fruit cups and a healthy snack.', category: 'Other', price: 70, image_url: null, is_available: true },
    ],
    orders: [
      {
        id: 'demo-order-1',
        canteen_id: 'canteen-base',
        status: 'delivered',
        total_amount: 160,
        created_at: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
        delivery_location: 'Hostel Block A - Room 204',
        order_items: [
          { product_name: 'Veg Thali', quantity: 1, unit_price: 90 },
          { product_name: 'Mango Shake', quantity: 1, unit_price: 60 },
        ],
      },
    ],
    delivery: {
      is_online: true,
      compensation_configured: false,
      available: [
        {
          id: 'demo-delivery-1',
          order_id: 'demo-order-2',
          pickup_location: 'Main Canteen',
          destination: 'Girls Hostel Block 2',
          status: 'new',
          created_at: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
          items: [
            { name: 'Paneer Roll', quantity: 2 },
            { name: 'Coconut Water', quantity: 1 },
          ],
        },
        {
          id: 'demo-delivery-2',
          order_id: 'demo-order-3',
          pickup_location: 'Hostel Kitchen',
          destination: 'Boys Hostel Block 4',
          status: 'new',
          created_at: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
          items: [{ name: 'Masala Maggi', quantity: 2 }],
        },
      ],
      active: [
        {
          id: 'demo-active-1',
          order_id: 'demo-order-4',
          pickup_location: 'Juice Corner',
          destination: 'Hostel Block C - Room 101',
          status: 'accepted',
          created_at: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
          items: [{ name: 'Fruit Bowl', quantity: 1 }],
        },
      ],
      completed: [
        {
          id: 'demo-complete-1',
          order_id: 'demo-order-5',
          pickup_location: 'Main Canteen',
          destination: 'Hostel Block B',
          status: 'delivered',
          created_at: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
          completed_at: new Date(Date.now() - 1000 * 60 * 60 * 10).toISOString(),
          items: [{ name: 'Veg Thali', quantity: 1 }],
        },
      ],
      earnings: [],
      total_earnings: 0,
    },
  }
}

function App() {
  const devBypassActive = isDevBypassEnabled()
  const [screen, setScreen] = useState<Screen>(() => devBypassActive ? 'dashboard' : 'welcome')
  const [session, setSession] = useState<Session | null>(() => devBypassActive ? createPreviewSession() : null)
  const [authReady, setAuthReady] = useState(!supabase || devBypassActive)
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('pickup')

  useEffect(() => {
    if (devBypassActive) return

    const client = supabase
    if (!client) return

    let active = true
    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (!error) {
        const verifiedSession = data.session?.user.email_confirmed_at && isOfficialEmail(data.session.user.email ?? '')
        setSession(verifiedSession ? data.session : null)
        if (verifiedSession) setScreen('dashboard')
        else if (data.session) {
          setScreen('auth')
          void client.auth.signOut()
        }
      }
      setAuthReady(true)
    })

    const { data: { subscription } } = client.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') {
        setScreen('reset')
        return
      }
      const verifiedSession = nextSession?.user.email_confirmed_at && isOfficialEmail(nextSession.user.email ?? '')
      setSession(verifiedSession ? nextSession : null)
      if (verifiedSession) setScreen('dashboard')
      else {
        setScreen((current) => current === 'dashboard' ? 'welcome' : current)
        if (nextSession) window.setTimeout(() => void client.auth.signOut(), 0)
      }
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [devBypassActive])

  function openAuth() {
    if (devBypassActive) {
      setSession(createPreviewSession())
      setScreen('dashboard')
      return
    }
    setScreen('auth')
  }

  async function logOut() {
    if (devBypassActive) {
      setWorkspaceTab('pickup')
      setSession(null)
      setScreen('welcome')
      return
    }
    if (!supabase) return
    await supabase.auth.signOut()
    setWorkspaceTab('pickup')
    setScreen('welcome')
  }

  if (screen === 'dashboard' && session) {
    return <Dashboard session={session} previewMode={devBypassActive} workspaceTab={workspaceTab} onWorkspaceChange={setWorkspaceTab} onLogout={() => void logOut()} />
  }

  if (screen === 'auth') {
    return <AuthScreen onBack={() => setScreen('welcome')} onAuthenticated={() => setScreen('dashboard')} />
  }

  if (screen === 'reset') {
    return <ResetPasswordScreen onFinished={() => setScreen('dashboard')} />
  }

  return <WelcomeScreen onContinue={openAuth} loading={!authReady} />
}

function Brand({ light = false }: { light?: boolean }) {
  return (
    <span className={`brand-lockup ${light ? 'brand-lockup-light' : ''}`}>
      <span className="brand-symbol"><Bike size={20} strokeWidth={2.4} /></span>
      <span>campus<span>rider</span></span>
    </span>
  )
}

function WelcomeScreen({ onContinue, loading }: { onContinue: () => void; loading: boolean }) {
  return (
    <main className="welcome-screen">
      <div className="welcome-photo" aria-hidden="true" />
      <div className="welcome-wash" aria-hidden="true" />
      <header className="welcome-nav"><Brand light /><span className="campus-tag"><MapPin size={14} /> NIT Srinagar</span></header>
      <section className="welcome-content">
        <div className="welcome-copy">
          <span className="welcome-kicker"><span /> YOUR CAMPUS, CONNECTED</span>
          <h1>Welcome to<br /><em>Campus Rider</em></h1>
          <p className="welcome-subtitle">Your Campus. Your Convenience. Your Rider.</p>
          <p className="welcome-description">A little closer to everything you need. Made for the people who make this campus feel like home.</p>
          <button className="continue-button" type="button" onClick={onContinue} disabled={loading}>
            {loading ? 'Checking your session' : 'Continue'} <ArrowRight size={18} />
          </button>
          <div className="welcome-trust"><ShieldCheck size={16} /><span>For the NIT Srinagar community</span></div>
        </div>
        <div className="campus-graphic" aria-hidden="true">
          <div className="graphic-sun" />
          <div className="graphic-orbit orbit-one" />
          <div className="graphic-orbit orbit-two" />
          <div className="graphic-pin"><MapPin size={23} fill="currentColor" /><span>NIT</span></div>
          <div className="graphic-path"><span /><span /><span /></div>
          <div className="graphic-bike"><Bike size={78} strokeWidth={1.15} /></div>
          <div className="graphic-label label-campus"><Compass size={13} /> campus routes</div>
          <div className="graphic-label label-community"><UsersRound size={13} /> student powered</div>
        </div>
      </section>
      <footer className="welcome-footer"><span>BUILT AROUND CAMPUS LIFE</span><span>01 <i>/</i> WELCOME</span></footer>
    </main>
  )
}

function AuthScreen({ onBack, onAuthenticated }: { onBack: () => void; onAuthenticated: () => void }) {
  const [tab, setTab] = useState<AuthTab>('login')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [recoverySent, setRecoverySent] = useState(false)

  function switchTab(nextTab: AuthTab) {
    setTab(nextTab)
    setMessage(null)
    setRecoverySent(false)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage(null)
    const cleanEmail = normalizedEmail(email)

    if (!cleanEmail) {
      setMessage({ kind: 'error', text: 'Please enter your college email address.' })
      return
    }
    if (!isOfficialEmail(cleanEmail)) {
      setMessage({ kind: 'error', text: officialEmailError })
      return
    }
    if (tab === 'signup') {
      if (!fullName.trim()) {
        setMessage({ kind: 'error', text: 'Please enter your full name.' })
        return
      }
      if (!passwordIsStrong(password)) {
        setMessage({ kind: 'error', text: 'Use at least 12 characters with an uppercase letter, a lowercase letter, a number, and a symbol.' })
        return
      }
      if (password !== confirmPassword) {
        setMessage({ kind: 'error', text: 'Your passwords do not match.' })
        return
      }
    } else if (!password) {
      setMessage({ kind: 'error', text: 'Please enter your password.' })
      return
    }
    if (!supabase) {
      setMessage({ kind: 'error', text: 'Authentication is not configured yet. Add the Supabase project URL and anon key to your local environment.' })
      return
    }

    setLoading(true)
    try {
      if (tab === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: { data: { full_name: fullName.trim() }, emailRedirectTo: window.location.origin },
        })
        if (error) throw error
        if (data.session?.user.email_confirmed_at && isOfficialEmail(data.session.user.email ?? '')) onAuthenticated()
        else {
          if (data.session) await supabase.auth.signOut()
          setMessage({ kind: 'success', text: 'Account created. Check your NIT Srinagar inbox for the verification link before logging in.' })
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password })
        if (error) throw error
        if (!data.user.email_confirmed_at) {
          await supabase.auth.signOut()
          setMessage({ kind: 'error', text: 'Please verify your college email from the link we sent before logging in.' })
          return
        }
        onAuthenticated()
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Something went wrong. Please try again.'
      setMessage({ kind: 'error', text: text.toLowerCase().includes('already registered') ? 'An account already exists for this email. Try logging in instead.' : text })
    } finally {
      setLoading(false)
    }
  }

  async function handleRecovery() {
    setMessage(null)
    if (!isOfficialEmail(email)) {
      setMessage({ kind: 'error', text: officialEmailError })
      return
    }
    if (!supabase) {
      setMessage({ kind: 'error', text: 'Authentication is not configured yet. Add the Supabase project URL and anon key to your local environment.' })
      return
    }
    setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail(email), { redirectTo: `${window.location.origin}/` })
    setLoading(false)
    if (error) setMessage({ kind: 'error', text: error.message })
    else setRecoverySent(true)
  }

  return (
    <main className="auth-screen">
      <aside className="auth-aside">
        <button className="back-link" type="button" onClick={onBack}><ArrowLeft size={16} /> Back to welcome</button>
        <Brand light />
        <div className="auth-aside-copy"><span className="welcome-kicker"><span /> CAMPUS RIDER COMMUNITY</span><h1>Good things<br />start <em>right here.</em></h1><p>Your campus is better when we look out for each other.</p></div>
        <div className="auth-aside-art"><div className="auth-art-circle" /><Bike size={124} strokeWidth={1} /><div className="auth-art-route"><span /><span /><span /></div><MapPin size={25} className="auth-art-pin" /></div>
        <div className="auth-aside-foot"><ShieldCheck size={15} /> NIT Srinagar student email required</div>
      </aside>
      <section className="auth-main">
        <div className="auth-card">
          <span className="section-eyebrow">YOUR CAMPUS ACCOUNT</span>
          <h2>{tab === 'login' ? 'Welcome back' : 'Join Campus Rider'}</h2>
          <p className="auth-intro">{tab === 'login' ? 'Sign in with your NIT Srinagar email to continue.' : 'Create your account with your official college email.'}</p>
          <div className="auth-tabs" role="tablist" aria-label="Account access">
            <button type="button" role="tab" aria-selected={tab === 'login'} className={tab === 'login' ? 'active' : ''} onClick={() => switchTab('login')}>Login</button>
            <button type="button" role="tab" aria-selected={tab === 'signup'} className={tab === 'signup' ? 'active' : ''} onClick={() => switchTab('signup')}>Sign Up</button>
          </div>
          {message && <div className={`form-message ${message.kind}`} role="status"><span>{message.kind === 'success' ? <Check size={16} /> : <CircleHelp size={16} />}</span>{message.text}</div>}
          {recoverySent ? (
            <div className="recovery-panel"><span className="recovery-icon"><Mail size={21} /></span><h3>Check your inbox</h3><p>If an account exists for {normalizedEmail(email)}, a password reset link is on its way.</p><button type="button" onClick={() => setRecoverySent(false)}>Back to login</button></div>
          ) : (
            <form className="auth-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
              {tab === 'signup' && <label className="form-field"><span>Full name</span><span className="field-wrap"><UserRound size={16} /><input autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Your name" required /></span></label>}
              <label className="form-field"><span>College email</span><span className="field-wrap"><Mail size={16} /><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} onBlur={() => setEmail(normalizedEmail(email))} placeholder="you@nitsri.ac.in" required /></span></label>
              <label className="form-field"><span>Password</span><span className="field-wrap"><LockKeyhole size={16} /><input type="password" autoComplete={tab === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={tab === 'signup' ? 'At least 12 characters' : 'Enter your password'} required /></span>{tab === 'signup' && <small>12+ characters, uppercase, lowercase, number and symbol</small>}</label>
              {tab === 'signup' && <label className="form-field"><span>Confirm password</span><span className="field-wrap"><LockKeyhole size={16} /><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Enter your password again" required /></span></label>}
              {tab === 'login' && <button className="forgot-link" type="button" onClick={() => void handleRecovery()} disabled={loading}>Forgot password?</button>}
              <button className="auth-submit" type="submit" disabled={loading}>{loading ? <><span className="spinner" /> Please wait</> : <>{tab === 'login' ? 'Login' : 'Create account'} <ArrowRight size={16} /></>}</button>
              {tab === 'signup' && <p className="verification-note"><ShieldCheck size={14} /> Your account stays inactive until you verify your NIT email.</p>}
            </form>
          )}
          <p className="auth-domain-note"><span className="domain-dot" /> Only <strong>@nitsri.ac.in</strong> addresses can join</p>
        </div>
        <footer className="auth-footer"><span>SECURE SIGN-IN</span><span>Campus Rider · NIT Srinagar</span></footer>
      </section>
    </main>
  )
}

function ResetPasswordScreen({ onFinished }: { onFinished: () => void }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [loading, setLoading] = useState(false)

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage(null)
    if (!passwordIsStrong(password)) {
      setMessage({ kind: 'error', text: 'Use at least 12 characters with an uppercase letter, a lowercase letter, a number, and a symbol.' })
      return
    }
    if (password !== confirmation) {
      setMessage({ kind: 'error', text: 'Your passwords do not match.' })
      return
    }
    if (!supabase) return
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) setMessage({ kind: 'error', text: error.message })
    else {
      setMessage({ kind: 'success', text: 'Password updated. You are signed in.' })
      window.setTimeout(onFinished, 650)
    }
  }

  return <main className="reset-screen"><div className="reset-card"><Brand /><span className="section-eyebrow">ACCOUNT RECOVERY</span><h1>Choose a new password</h1><p>Make it strong and keep it somewhere safe.</p>{message && <div className={`form-message ${message.kind}`} role="status">{message.text}</div>}<form className="auth-form" onSubmit={(event) => void savePassword(event)}><label className="form-field"><span>New password</span><span className="field-wrap"><LockKeyhole size={16} /><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></span></label><label className="form-field"><span>Confirm new password</span><span className="field-wrap"><LockKeyhole size={16} /><input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></span></label><button className="auth-submit" type="submit" disabled={loading}>{loading ? 'Saving password…' : 'Update password'} <ArrowRight size={16} /></button></form></div></main>
}

function Dashboard({ session, previewMode, workspaceTab, onWorkspaceChange, onLogout }: { session: Session; previewMode: boolean; workspaceTab: WorkspaceTab; onWorkspaceChange: (tab: WorkspaceTab) => void; onLogout: () => void }) {
  const name = session.user.user_metadata.full_name?.trim() || session.user.email?.split('@')[0] || 'Rider'
  const [canteens, setCanteens] = useState<Canteen[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [delivery, setDelivery] = useState<DeliveryWorkspace | null>(null)
  const [cart, setCart] = useState<Record<string, number>>({})
  const [selectedCanteen, setSelectedCanteen] = useState('all')
  const [destination, setDestination] = useState('')
  const [searchText, setSearchText] = useState('')
  const [category, setCategory] = useState<MenuCategory>('All')
  const [profileOpen, setProfileOpen] = useState(false)
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function refreshDashboard(showLoading = true) {
    if (!supabase && !previewMode) return

    if (!supabase && previewMode) {
      const demoData = getPreviewDashboardData()
      setCanteens(demoData.canteens as Canteen[])
      setProducts(demoData.products as Product[])
      setOrders(demoData.orders as unknown as OrderRow[])
      setDelivery(demoData.delivery as DeliveryWorkspace)
      setError('')
      if (showLoading) setLoading(false)
      return
    }

    const [canteenResult, productResult, orderResult, deliveryResult] = await Promise.all([
      supabase!.from('canteens').select('id,name,description,location,is_active').eq('is_active', true).order('name'),
      supabase!.from('products').select('id,canteen_id,name,description,category,price,image_url,is_available').eq('is_available', true).order('name'),
      supabase!.from('orders').select('id,canteen_id,status,total_amount,created_at,delivery_location,order_items(product_name,quantity,unit_price)').eq('customer_id', session.user.id).order('created_at', { ascending: false }).limit(20),
      supabase!.rpc('get_delivery_workspace'),
    ])
    const failure = canteenResult.error ?? productResult.error ?? orderResult.error ?? deliveryResult.error
    if (failure) setError('Some Campus Rider data could not be loaded. Check your connection or refresh to try again.')
    else setError('')
    if (!canteenResult.error) setCanteens(canteenResult.data ?? [])
    if (!productResult.error) setProducts(productResult.data ?? [])
    if (!orderResult.error) setOrders((orderResult.data ?? []) as unknown as OrderRow[])
    if (!deliveryResult.error) setDelivery(deliveryResult.data as DeliveryWorkspace)
    if (showLoading) setLoading(false)
  }

  const refreshDashboardEvent = useEffectEvent(refreshDashboard)

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refreshDashboardEvent(), 0)
    const timer = window.setInterval(() => void refreshDashboardEvent(false), 15000)
    return () => {
      window.clearTimeout(initialRefresh)
      window.clearInterval(timer)
    }
  }, [session.user.id])

  async function runAction(action: () => PromiseLike<{ error?: { message: string } | null }>, successMessage: string) {
    if (!supabase) {
      if (previewMode) {
        setBusy(true)
        setNotice('Development preview mode is active. No database write is performed while previewing the dashboard.')
        setBusy(false)
        return
      }
      return
    }

    setBusy(true)
    setError('')
    setNotice('')
    const result = await action()
    if (result.error) setError(result.error.message.includes('no longer available') ? 'That delivery was just accepted by another student. Refresh to see current opportunities.' : result.error.message)
    else {
      setNotice(successMessage)
      await refreshDashboard()
    }
    setBusy(false)
  }

  async function placeOrder() {
    if (!supabase) {
      if (previewMode) {
        setBusy(true)
        setError('')
        setNotice('Development preview mode is active. The dashboard is showing sample data only, and no order is stored in the database.')
        setCart({})
        setDestination('')
        setBusy(false)
        return
      }
      return
    }

    if (!Object.keys(cart).length || destination.trim().length < 2) return
    setBusy(true)
    setError('')
    setNotice('')
    const items = Object.entries(cart).map(([product_id, quantity]) => ({ product_id, quantity }))
    const { error: orderError } = await supabase.rpc('place_order', { items, delivery_destination: destination.trim() })
    if (orderError) setError(orderError.message)
    else {
      setCart({})
      setDestination('')
      setNotice('Your order has been placed and is now available for a student rider.')
      await refreshDashboard()
    }
    setBusy(false)
  }

  const allProducts = products
  const filteredProducts = allProducts.filter((product) => {
    const canteen = canteens.find((entry) => entry.id === product.canteen_id)
    const query = `${product.name} ${product.description} ${canteen?.name ?? ''}`.toLowerCase()
    return query.includes(searchText.toLowerCase())
      && (category === 'All' || product.category === category)
      && (selectedCanteen === 'all' || product.canteen_id === selectedCanteen)
  })
  const cartTotal = products.reduce((sum, product) => sum + product.price * (cart[product.id] ?? 0), 0)
  const itemCount = Object.values(cart).reduce((sum, count) => sum + count, 0)
  const categories: MenuCategory[] = ['All', 'Food', 'Drinks', 'Other']

  return (
    <main className="dashboard-shell">
      <header className="dashboard-topbar"><a className="dashboard-brand" href="#pickup" onClick={(event) => { event.preventDefault(); onWorkspaceChange('pickup') }}><Brand /></a><div className="dashboard-campus"><MapPin size={14} /> NIT Srinagar</div><div className="dashboard-user-wrap"><button className="dashboard-user" type="button" aria-expanded={profileOpen} onClick={() => setProfileOpen(!profileOpen)}><span className="user-avatar">{name.charAt(0).toUpperCase()}</span><span>{name}</span><ChevronDown size={14} /></button>{profileOpen && <div className="profile-menu"><strong>{name}</strong><span>{session.user.email}</span><button type="button" onClick={() => { setAccountSettingsOpen(true); setProfileOpen(false) }}><UserRound size={15} /> Account settings</button><button type="button" onClick={onLogout}><LogOut size={15} /> Log out</button></div>}</div></header>
      {accountSettingsOpen && <div className="account-modal-backdrop" onClick={() => setAccountSettingsOpen(false)}><section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-settings-title" onClick={(event) => event.stopPropagation()}><div className="account-modal-heading"><div><span className="section-eyebrow">CAMPUS RIDER ACCOUNT</span><h2 id="account-settings-title">Account settings</h2></div><button className="icon-action" type="button" aria-label="Close account settings" onClick={() => setAccountSettingsOpen(false)}><X size={16} /></button></div><div className="account-detail"><span className="account-detail-icon"><UserRound size={17} /></span><span><small>FULL NAME</small><strong>{name}</strong></span></div><div className="account-detail"><span className="account-detail-icon"><Mail size={17} /></span><span><small>COLLEGE EMAIL</small><strong>{session.user.email}</strong></span></div><div className="account-verified"><ShieldCheck size={16} /> Verified NIT Srinagar student</div><button className="account-logout" type="button" onClick={onLogout}><LogOut size={16} /> Log out of Campus Rider</button></section></div>}
      <div className="dashboard-welcome"><span className="section-eyebrow">YOUR CAMPUS IS READY</span><h1>Hey, {name.split(' ')[0]}<span>.</span></h1><p>Find a rider for your pickup or help a fellow student.</p></div>
      {previewMode && <div className="dashboard-alert success" role="status"><Check size={16} />Demo preview mode is active — local sample data only, no Supabase auth or database writes.</div>}
      <div className="workspace-switch" role="tablist" aria-label="Choose Campus Rider workspace"><button type="button" role="tab" aria-selected={workspaceTab === 'pickup'} className={workspaceTab === 'pickup' ? 'active' : ''} onClick={() => onWorkspaceChange('pickup')}><MapPinned size={16} /> PICKUPS</button><button type="button" role="tab" aria-selected={workspaceTab === 'order'} className={workspaceTab === 'order' ? 'active' : ''} onClick={() => onWorkspaceChange('order')}><ShoppingBag size={16} /> ORDER</button><button type="button" role="tab" aria-selected={workspaceTab === 'deliver'} className={workspaceTab === 'deliver' ? 'active' : ''} onClick={() => onWorkspaceChange('deliver')}><Bike size={17} /> DELIVER</button></div>
      {error && <div className="dashboard-alert error" role="alert"><CircleHelp size={16} />{error}<button type="button" onClick={() => void refreshDashboard()}>Retry</button></div>}
      {notice && <div className="dashboard-alert success" role="status"><Check size={16} />{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice('')}>×</button></div>}
      {workspaceTab === 'pickup' ? <Suspense fallback={<div className="pickup-loading"><LoaderCircle size={18} /> Loading pickup workspace…</div>}><PickupWorkspace session={session} previewMode={previewMode} /></Suspense> : (
      <section className={`workspace-grid ${workspaceTab === 'deliver' ? 'show-deliver' : 'show-order'}`}>
        <OrderWorkspace
          canteens={canteens} products={filteredProducts} allProducts={products} orders={orders} cart={cart} cartTotal={cartTotal} itemCount={itemCount}
          destination={destination} searchText={searchText} category={category} categories={categories} selectedCanteen={selectedCanteen} loading={loading} busy={busy}
          onDestinationChange={setDestination} onSearch={setSearchText} onCategory={setCategory}
          onCanteenSelect={setSelectedCanteen} onClearCart={() => setCart({})}
          onQuantityChange={(id, change) => {
            const product = products.find((entry) => entry.id === id) ?? allProducts.find((entry) => entry.id === id)
            if (change > 0 && product && Object.entries(cart).some(([cartProductId, quantity]) => quantity > 0 && allProducts.find((entry) => entry.id === cartProductId)?.canteen_id !== product.canteen_id)) {
              setError('Place a separate order for each canteen. Clear your cart before adding products from another canteen.')
              return
            }
            setCart((current) => { const next = { ...current }; const amount = (next[id] ?? 0) + change; if (amount <= 0) delete next[id]; else next[id] = amount; return next })
          }}
          onPlaceOrder={() => void placeOrder()} onRefresh={() => void refreshDashboard()}
        />
        <DeliveryWorkspaceView
          state={delivery} busy={busy} loading={loading}
          onRefresh={() => void refreshDashboard()}
          onAvailabilityChange={(online) => void runAction(() => supabase ? supabase.rpc('set_rider_availability', { available: online }) : Promise.resolve({ error: null }), online ? 'You are online and can receive delivery opportunities.' : 'You are now offline.')}
          onAccept={(id) => void runAction(() => supabase ? supabase.rpc('accept_delivery', { delivery_uuid: id }) : Promise.resolve({ error: null }), 'Delivery accepted. It is now assigned to you.')}
          onStatusChange={(id, status) => void runAction(() => supabase ? supabase.rpc('update_delivery_status', { delivery_uuid: id, next_status: status }) : Promise.resolve({ error: null }), status === 'delivered' ? 'Delivery completed. Earnings are recorded only when compensation is configured.' : 'Pickup confirmed. The customer can see the updated status.')}
        />
      </section>)}
      <footer className="dashboard-footer"><span>Campus Rider · NIT Srinagar</span><span>One account, student powered.</span></footer>
      <nav className="mobile-nav" aria-label="Campus Rider workspaces"><button type="button" className={workspaceTab === 'pickup' ? 'active' : ''} onClick={() => onWorkspaceChange('pickup')}><MapPinned size={18} /><span>PICKUPS</span></button><button type="button" className={workspaceTab === 'order' ? 'active' : ''} onClick={() => onWorkspaceChange('order')}><ShoppingBag size={18} /><span>ORDER</span></button><button type="button" className={workspaceTab === 'deliver' ? 'active' : ''} onClick={() => onWorkspaceChange('deliver')}><Bike size={19} /><span>DELIVER</span></button><button type="button" onClick={onLogout}><LogOut size={18} /><span>LOGOUT</span></button></nav>
    </main>
  )
}

function OrderWorkspace({ canteens, products, allProducts, orders, cart, cartTotal, itemCount, destination, searchText, category, categories, selectedCanteen, loading, busy, onDestinationChange, onSearch, onCategory, onCanteenSelect, onClearCart, onQuantityChange, onPlaceOrder, onRefresh }: {
  canteens: Canteen[]; products: Product[]; allProducts: Product[]; orders: OrderRow[]; cart: Record<string, number>; cartTotal: number; itemCount: number; destination: string; searchText: string; category: MenuCategory; categories: MenuCategory[]; selectedCanteen: string; loading: boolean; busy: boolean
  onDestinationChange: (value: string) => void; onSearch: (value: string) => void; onCategory: (value: MenuCategory) => void; onCanteenSelect: (value: string) => void; onClearCart: () => void; onQuantityChange: (id: string, change: number) => void; onPlaceOrder: () => void; onRefresh: () => void
}) {
  return <section className="workspace-panel order-panel" aria-labelledby="order-title"><div className="workspace-panel-head"><div className="panel-icon order-icon"><ShoppingBag size={19} /></div><div><span className="section-eyebrow">BUY PRODUCTS</span><h2 id="order-title">ORDER</h2></div><button className="icon-action" type="button" onClick={onRefresh} title="Refresh order data" aria-label="Refresh order data"><LoaderCircle size={16} /></button></div><div className="workspace-panel-body"><div className="workspace-subhead"><div><span className="section-eyebrow">CAMPUS MARKETPLACE</span><h3>Explore Canteens</h3></div><span className="count-label">{canteens.length} OPEN</span></div><label className="workspace-search"><Search size={16} /><input value={searchText} onChange={(event) => onSearch(event.target.value)} placeholder="Search canteens or products" aria-label="Search canteens or products" /></label><div className="canteen-filter-list" aria-label="Filter by canteen"><button type="button" className={selectedCanteen === 'all' ? 'active' : ''} onClick={() => onCanteenSelect('all')}>All canteens</button>{canteens.map((canteen) => <button type="button" key={canteen.id} title={`${canteen.name} · ${canteen.location}`} className={selectedCanteen === canteen.id ? 'active' : ''} onClick={() => onCanteenSelect(canteen.id)}>{canteen.name}</button>)}</div><div className="filter-tabs" aria-label="Product category">{categories.map((item) => <button key={item} type="button" className={category === item ? 'active' : ''} onClick={() => onCategory(item)}>{item}</button>)}</div>
    {loading ? <div className="workspace-loading"><span className="spinner dark-spinner" /> Loading canteens and products…</div> : canteens.length === 0 ? <div className="workspace-empty"><div className="workspace-empty-icon"><Compass size={22} /></div><strong>No canteens available yet. Campus Rider is preparing to launch.</strong><p>Reviewed canteens and products will appear here when they’re ready.</p></div> : allProducts.length === 0 ? <div className="workspace-empty"><div className="workspace-empty-icon"><ShoppingBag size={22} /></div><strong>No products available yet.</strong><p>Products will appear after listings are added and reviewed.</p></div> : products.length === 0 ? <div className="workspace-empty compact-empty"><strong>No products match that search.</strong><p>Try another search, canteen, or category.</p></div> : <div className="product-list">{products.map((product) => <article className="product-row" key={product.id}><div className="product-thumbnail">{product.image_url ? <img src={product.image_url} alt="" /> : <ShoppingBag size={18} />}</div><div className="product-main"><strong>{product.name}</strong><span>{canteens.find((canteen) => canteen.id === product.canteen_id)?.name}</span><small>{product.description}</small></div><div className="product-buy"><strong>₹{Number(product.price).toFixed(2)}</strong>{cart[product.id] ? <span className="product-stepper"><button type="button" aria-label={`Remove ${product.name}`} onClick={() => onQuantityChange(product.id, -1)}><Minus size={12} /></button>{cart[product.id]}<button type="button" aria-label={`Add ${product.name}`} onClick={() => onQuantityChange(product.id, 1)}><Plus size={12} /></button></span> : <button className="product-add" type="button" onClick={() => onQuantityChange(product.id, 1)}>Add</button>}</div></article>)}</div>}
    <div className="order-compose"><label><span>HOSTEL / DELIVERY DESTINATION</span><input value={destination} onChange={(event) => onDestinationChange(event.target.value)} placeholder="Enter your hostel and room details" maxLength={240} /></label><div className="cart-summary"><span><ShoppingBag size={14} /> Cart <b>{itemCount}</b></span><strong>{allProducts.length ? `₹${cartTotal.toFixed(2)}` : '—'}</strong>{itemCount > 0 && <button className="clear-cart" type="button" onClick={onClearCart}>Clear</button>}</div><button className="primary-action" type="button" disabled={busy || !itemCount || destination.trim().length < 2} onClick={onPlaceOrder}>{busy ? <><span className="spinner" /> Placing order…</> : <>Place order <ArrowRight size={16} /></>}</button><small className="dev-payment-note">Payment is not configured. No payment is collected in this version.</small></div>
    <div className="orders-history"><div className="workspace-subhead history-heading"><div><span className="section-eyebrow">PURCHASE TRACKING</span><h3>My Orders</h3></div><span className="count-label">{orders.length}</span></div>{loading ? <p className="small-muted">Loading order history…</p> : orders.length === 0 ? <p className="small-muted">Your order history will appear here.</p> : <div className="order-history-list">{orders.map((order) => <article className="history-order" key={order.id}><div className="history-order-top"><strong>{order.order_items.map((item) => `${item.quantity}× ${item.product_name}`).join(', ')}</strong><span className={`status-chip status-${order.status}`}>{order.status.replaceAll('_', ' ')}</span></div><div><span>{order.delivery_location}</span><b>₹{Number(order.total_amount).toFixed(2)}</b></div><time>{new Date(order.created_at).toLocaleString()}</time></article>)}</div>}</div>
  </div></section>
}

function DeliveryWorkspaceView({ state, busy, loading, onRefresh, onAvailabilityChange, onAccept, onStatusChange }: {
  state: DeliveryWorkspace | null; busy: boolean; loading: boolean; onRefresh: () => void; onAvailabilityChange: (online: boolean) => void; onAccept: (id: string) => void; onStatusChange: (id: string, status: 'picked_up' | 'delivered') => void
}) {
  const isOnline = state?.is_online ?? false
  return <section className="workspace-panel deliver-panel" aria-labelledby="deliver-title"><div className="workspace-panel-head"><div className="panel-icon deliver-icon"><Bike size={20} /></div><div><span className="section-eyebrow">EARN ON YOUR ROUTE</span><h2 id="deliver-title">DELIVER</h2></div><span className={`online-indicator ${isOnline ? 'online' : ''}`}><span />{isOnline ? 'ONLINE' : 'OFFLINE'}</span></div><div className="workspace-panel-body"><div className="availability-card"><div><strong>{isOnline ? 'You’re ready for a delivery' : 'Want to deliver on campus?'}</strong><p>{isOnline ? 'Eligible requests will appear here.' : 'Go online when you’re available to ride.'}</p></div><button className={`availability-toggle ${isOnline ? 'online' : ''}`} type="button" role="switch" aria-checked={isOnline} aria-label={isOnline ? 'Go offline' : 'Go online'} disabled={busy || loading} onClick={() => onAvailabilityChange(!isOnline)}><span /></button></div><div className="workspace-subhead delivery-list-heading"><div><span className="section-eyebrow">RIDER WORKSPACE</span><h3>Available Deliveries</h3></div><button className="icon-action" type="button" onClick={onRefresh} title="Refresh delivery data" aria-label="Refresh delivery data"><LoaderCircle size={16} /></button></div>{loading ? <div className="workspace-loading"><span className="spinner dark-spinner" /> Loading deliveries…</div> : !isOnline ? <div className="workspace-empty deliver-empty"><div className="workspace-empty-icon"><Bike size={22} /></div><strong>Go online to see available deliveries.</strong><p>Your account works for ordering and delivering. No second registration needed.</p></div> : !state?.available.length ? <div className="workspace-empty deliver-empty"><div className="workspace-empty-icon"><MapPinned size={22} /></div><strong>No deliveries available right now. Go online to receive eligible delivery opportunities.</strong><p>Requests from your campus will appear here when available.</p></div> : <div className="delivery-list">{state.available.map((item) => <article className="delivery-card" key={item.id}><div className="delivery-card-top"><span>DELIVERY REQUEST</span><time>{new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p><MapPin size={14} /><span><b>Pickup</b>{item.pickup_location}</span></p><p><MapPinned size={14} /><span><b>Drop-off</b>{item.destination}</span></p>{item.items?.length ? <small>{item.items.map((line) => `${line.quantity}× ${line.name}`).join(', ')}</small> : null}<button className="accept-action" type="button" disabled={busy} onClick={() => onAccept(item.id)}>Accept delivery <ArrowRight size={15} /></button></article>)}</div>}
    <div className="active-deliveries"><div className="workspace-subhead"><div><span className="section-eyebrow">YOUR RIDES</span><h3>My Active Deliveries</h3></div><span className="count-label">{state?.active.length ?? 0}</span></div>{loading ? <p className="small-muted">Loading active deliveries…</p> : !state?.active.length ? <p className="small-muted">Accepted deliveries will appear here.</p> : <div className="delivery-list">{state.active.map((item) => <article className="delivery-card active-delivery" key={item.id}><span className={`status-chip status-${item.status}`}>{item.status?.replaceAll('_', ' ')}</span><p><MapPin size={14} /><span><b>Pickup</b>{item.pickup_location}</span></p><p><MapPinned size={14} /><span><b>Drop-off</b>{item.destination}</span></p>{item.items?.length ? <small>{item.items.map((line) => `${line.quantity}× ${line.name}`).join(', ')}</small> : null}{item.status === 'accepted' && <button className="accept-action" type="button" disabled={busy} onClick={() => onStatusChange(item.id, 'picked_up')}><PackageCheck size={15} /> Confirm pickup</button>}{item.status === 'picked_up' && <button className="accept-action" type="button" disabled={busy} onClick={() => onStatusChange(item.id, 'delivered')}><Check size={15} /> Mark delivered</button>}</article>)}</div>}</div>
    <div className="earnings-section"><div className="workspace-subhead"><div><span className="section-eyebrow">DELIVERED RIDES</span><h3>Completed & Earnings</h3></div></div><div className="earnings-total"><span>Total recorded earnings</span><strong>{state?.compensation_configured ? `₹${Number(state.total_earnings).toFixed(2)}` : 'Not configured'}</strong><small>{state?.compensation_configured ? 'Based on configured rider compensation.' : 'Earnings will appear after Campus Rider configures rider compensation.'}</small></div>{!loading && !(state?.completed.length) && <p className="small-muted completed-empty">Completed deliveries will appear here.</p>}{state?.completed.map((item) => <div className="ledger-row" key={item.id}><span><strong>Delivery to {item.destination}</strong><small>Completed {item.completed_at ? new Date(item.completed_at).toLocaleDateString() : ''}</small></span><b>Delivered</b></div>)}{state?.earnings.map((entry) => <div className="ledger-row" key={entry.id}><span><strong>Earnings ledger</strong><small>{new Date(entry.created_at).toLocaleDateString()}</small></span><b>{entry.amount === null ? 'Pending compensation setup' : `₹${Number(entry.amount).toFixed(2)}`}</b></div>)}</div>
  </div></section>
}

export default App