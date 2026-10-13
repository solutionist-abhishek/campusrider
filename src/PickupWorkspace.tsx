import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bike,
  Check,
  CircleHelp,
  Clock3,
  Coffee,
  Copy,
  CreditCard,
  DoorOpen,
  ExternalLink,
  LoaderCircle,
  MapPin,
  MessageCircle,
  Plus,
  Send,
  ShieldCheck,
  Store,
  Trash2,
  X,
} from 'lucide-react'
import QRCode from 'qrcode'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'

type PickupLocationId = 'canteen' | 'cafeteria' | 'gate'
type PickupPage = 'locations' | 'riders' | 'chat'
type Message = { id: string; sender_id: string; body: string; created_at: string }
type QuoteItem = { id: string; item_name: string; quantity: number; unit_price: number; line_total: number }
type Quote = {
  id: string
  item_subtotal: number
  delivery_fee: number
  total_amount: number
  delivery_destination: string | null
  estimated_minutes: number | null
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded'
  created_at: string
  quote_items: QuoteItem[]
}
type ChatEvent =
  | { kind: 'message'; id: string; created_at: string; message: Message }
  | { kind: 'quote'; id: string; created_at: string; quote: Quote }
type Rider = {
  rider_id: string
  full_name: string
  avatar_url: string | null
  workload: number
  capacity: number
  delivery_fee: number
}
type RiderDiscoveryStatus =
  | 'verification_incomplete'
  | 'no_rider_mode'
  | 'offline'
  | 'location'
  | 'pricing'
  | 'capacity'
  | 'available'

const riderDiscoveryStatuses = new Set<string>([
  'verification_incomplete',
  'no_rider_mode',
  'offline',
  'location',
  'pricing',
  'capacity',
  'available',
])

function isRiderDiscoveryStatus(value: unknown): value is RiderDiscoveryStatus {
  return typeof value === 'string' && riderDiscoveryStatuses.has(value)
}

type ConversationSummary = {
  conversation_id: string
  pickup_location_id: PickupLocationId
  pickup_name: string
  other_person_name: string
  request_status: string | null
  destination: string | null
  last_message: string | null
  updated_at: string
  is_customer: boolean
  conversation_status: 'open' | 'closed'
}
type RiderSettings = {
  is_online: boolean
  supported_locations: PickupLocationId[]
  capacity: number
  workload: number
  pickup_delivery_fees: Partial<Record<PickupLocationId, number>>
}
type PickupLocation = {
  id: PickupLocationId
  name: string
  minimum_rider_delivery_fee: number
  maximum_rider_delivery_fee: number | null
}
type PickupOrder = {
  id: string
  status: string
  total_amount: number
  delivery_fee: number | null
  payment_status: 'unpaid' | 'payment_reported' | 'paid' | 'migration_unavailable'
  delivery_location: string
  created_at: string
  pickup_location_id: PickupLocationId | null
  accepted_quote_id: string | null
  delivery_partner_id: string | null
  order_items: { product_name: string; quantity: number; unit_price: number }[]
}
type PickupOrderRow = Omit<PickupOrder, 'payment_status'> & { payment_status?: PickupOrder['payment_status'] }
type RiderPaymentSettings = {
  upi_id: string
  payment_qr_path: string | null
  payment_enabled: boolean
}
type OrderPaymentDetails = {
  order_id: string
  order_status: string
  total_amount: string
  item_subtotal: string
  delivery_fee: string
  payment_status: 'unpaid' | 'payment_reported' | 'paid'
  payment_reported_at: string | null
  payment_confirmed_at: string | null
  rider_id: string
  rider_name: string
  rider_upi_id: string | null
  rider_qr_path: string | null
}
type DraftItem = { key: number; name: string; quantity: string; unitPrice: string }

const paymentQrBucket = 'rider-payment-qr'
const maximumPaymentQrSize = 5 * 1024 * 1024
const validUpiId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}@[A-Za-z][A-Za-z0-9.-]{0,63}$/

const locations: { id: PickupLocationId; name: string; description: string; Icon: typeof Store }[] = [
  { id: 'canteen', name: 'Canteen', description: 'Find a rider to collect your canteen items.', Icon: Store },
  { id: 'cafeteria', name: 'Cafeteria', description: 'Request food and other cafeteria items.', Icon: Coffee },
  { id: 'gate', name: 'Gate', description: 'Arrange a pickup or collection at the college gate.', Icon: DoorOpen },
]

const orderSteps: Record<string, string> = {
  accepted: 'Request accepted',
  collecting: 'Collecting items',
  collected: 'Items collected',
  on_the_way: 'On the way',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatAmountForUpi(value: string) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) throw new Error('The accepted order total is not a valid INR amount.')
  return `${match[1]}.${(match[2] ?? '').padEnd(2, '0')}`
}

function formatAcceptedLineAmount(quantity: number, unitPrice: number) {
  return (Math.round(unitPrice * 100) * quantity / 100).toFixed(2)
}

async function hasValidPaymentQrImageSignature(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const isPng = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const isWebp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  return (file.type === 'image/png' && isPng)
    || (file.type === 'image/jpeg' && isJpeg)
    || (file.type === 'image/webp' && isWebp)
}

function buildOrderUpiUri(details: OrderPaymentDetails) {
  if (!details.rider_upi_id) return null
  const params = new URLSearchParams({
    pa: details.rider_upi_id,
    pn: details.rider_name,
    am: formatAmountForUpi(details.total_amount),
    cu: 'INR',
    tr: details.order_id.replaceAll('-', '').slice(0, 32),
    tn: `Campus Rider ${details.order_id.slice(0, 8)}`,
  })
  return `upi://pay?${params.toString()}`
}

function getRiderDiscoveryEmptyState(status: RiderDiscoveryStatus | null, locationName: string) {
  switch (status) {
    case 'verification_incomplete':
      return {
        title: 'Email verification is required',
        message: 'Students must verify their NIT Srinagar email before they can activate rider mode.',
      }
    case 'no_rider_mode':
      return {
        title: 'No students have activated rider mode yet',
        message: 'A verified student must activate rider mode and finish the setup below before appearing here.',
      }
    case 'offline':
      return {
        title: 'No riders are online right now',
        message: 'Riders must switch online to accept new pickup requests.',
      }
    case 'location':
      return {
        title: `No online riders serve ${locationName}`,
        message: 'Riders must select this pickup point in their delivery settings.',
      }
    case 'pricing':
      return {
        title: 'Rider pricing is not configured yet',
        message: 'Riders need a valid delivery price for this pickup point. The administrator must configure its allowed price range first.',
      }
    case 'capacity':
      return {
        title: 'Available riders are at capacity',
        message: 'Try again later when an online rider has capacity for a new request.',
      }
    default:
      return {
        title: 'No riders are available right now',
        message: 'Try again shortly or choose another pickup location.',
      }
  }
}

export default function PickupWorkspace({ session, previewMode }: { session: Session; previewMode: boolean }) {
  const [page, setPage] = useState<PickupPage>('locations')
  const [selectedLocation, setSelectedLocation] = useState<PickupLocationId | null>(null)
  const [riders, setRiders] = useState<Rider[]>([])
  const [ridersLoading, setRidersLoading] = useState(false)
  const [riderDiscoveryStatus, setRiderDiscoveryStatus] = useState<RiderDiscoveryStatus | null>(null)
  const [riderDiscoveryError, setRiderDiscoveryError] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [pickupLocations, setPickupLocations] = useState<PickupLocation[]>([])
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [orders, setOrders] = useState<PickupOrder[]>([])
  const [riderPaymentSettings, setRiderPaymentSettings] = useState<RiderPaymentSettings>({
    upi_id: '',
    payment_qr_path: null,
    payment_enabled: false,
  })
  const [paymentQrFile, setPaymentQrFile] = useState<File | null>(null)
  const [removeSavedPaymentQr, setRemoveSavedPaymentQr] = useState(false)
  const [savedPaymentQrUrl, setSavedPaymentQrUrl] = useState('')
  const [paymentSettingsBusy, setPaymentSettingsBusy] = useState(false)
  const [paymentSettingsInitialized, setPaymentSettingsInitialized] = useState(false)
  const [paymentMigrationMissing, setPaymentMigrationMissing] = useState(false)
  const [paymentSettingsError, setPaymentSettingsError] = useState('')
  const [paymentSettingsNotice, setPaymentSettingsNotice] = useState('')
  const [paymentOrderId, setPaymentOrderId] = useState<string | null>(null)
  const [paymentDetails, setPaymentDetails] = useState<OrderPaymentDetails | null>(null)
  const [paymentQrDataUrl, setPaymentQrDataUrl] = useState('')
  const [paymentLoading, setPaymentLoading] = useState(false)
  const [paymentError, setPaymentError] = useState('')
  const [paymentActionBusy, setPaymentActionBusy] = useState(false)
  const [paymentActionNotice, setPaymentActionNotice] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const [settings, setSettings] = useState<RiderSettings>({
    is_online: false,
    supported_locations: [],
    capacity: 3,
    workload: 0,
    pickup_delivery_fees: {},
  })
  const [draftLocations, setDraftLocations] = useState<PickupLocationId[]>([])
  const [draftFees, setDraftFees] = useState<Record<PickupLocationId, string>>({
    canteen: '',
    cafeteria: '',
    gate: '',
  })
  const [message, setMessage] = useState('')
  const [destination, setDestination] = useState('')
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ key: 1, name: '', quantity: '1', unitPrice: '' }])
  const [eta, setEta] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [settingsInitialized, setSettingsInitialized] = useState(false)
  const [error, setError] = useState('')
  const [riderSettingsError, setRiderSettingsError] = useState('')
  const [notice, setNotice] = useState('')
  const [nextItemKey, setNextItemKey] = useState(2)
  const timelineEnd = useRef<HTMLDivElement>(null)
  const riderSearchId = useRef(0)
  const paymentModalRef = useRef<HTMLElement | null>(null)
  const paymentReturnFocusRef = useRef<HTMLElement | null>(null)
  const [paymentQrPreviewUrl, setPaymentQrPreviewUrl] = useState('')
  const paymentQrPreviewUrlRef = useRef('')

  function updatePaymentQrFile(file: File | null) {
    if (paymentQrPreviewUrlRef.current) URL.revokeObjectURL(paymentQrPreviewUrlRef.current)
    paymentQrPreviewUrlRef.current = file ? URL.createObjectURL(file) : ''
    setPaymentQrFile(file)
    setPaymentQrPreviewUrl(paymentQrPreviewUrlRef.current)
  }

  useEffect(() => () => {
    if (paymentQrPreviewUrlRef.current) URL.revokeObjectURL(paymentQrPreviewUrlRef.current)
  }, [])

  useEffect(() => {
    if (paymentOrderId) paymentModalRef.current?.focus()
    else paymentReturnFocusRef.current?.focus()
  }, [paymentOrderId])

  async function refreshHome(showLoading = false) {
    if (!supabase) {
      setError('Supabase is not configured. Add the project URL and publishable key to the hosting environment.')
      setLoading(false)
      return
    }
    if (showLoading) setLoading(true)
    const [locationResult, conversationResult, orderResult, settingsResult, feeResult, paymentSettingsResult] = await Promise.all([
      supabase.from('pickup_locations')
        .select('id,name,minimum_rider_delivery_fee,maximum_rider_delivery_fee')
        .eq('is_active', true),
      supabase.rpc('get_my_pickup_conversations'),
      supabase.from('orders')
        .select('id,status,total_amount,delivery_fee,payment_status,delivery_location,created_at,pickup_location_id,accepted_quote_id,delivery_partner_id,order_items(product_name,quantity,unit_price)')
        .or(`customer_id.eq.${session.user.id},delivery_partner_id.eq.${session.user.id}`)
        .not('accepted_quote_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase.rpc('get_my_rider_pickup_settings'),
      supabase.rpc('get_my_rider_pickup_fees'),
      supabase.rpc('get_my_rider_payment_settings'),
    ])
    let orderRows: PickupOrderRow[] | null = orderResult.data
    let orderError = orderResult.error
    const paymentColumnMissing = Boolean(orderError
      && ['42703', 'PGRST204'].includes(orderError.code)
      && orderError.message.includes('payment_status'))
    if (paymentColumnMissing) {
      const fallbackOrders = await supabase.from('orders')
        .select('id,status,total_amount,delivery_fee,delivery_location,created_at,pickup_location_id,accepted_quote_id,delivery_partner_id,order_items(product_name,quantity,unit_price)')
        .or(`customer_id.eq.${session.user.id},delivery_partner_id.eq.${session.user.id}`)
        .not('accepted_quote_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(30)
      orderRows = fallbackOrders.data
      orderError = fallbackOrders.error
    }
    const paymentMigrationUnavailable = paymentColumnMissing || paymentSettingsResult.error?.code === 'PGRST202'
    setPaymentMigrationMissing(paymentMigrationUnavailable)
    const failure = locationResult.error ?? conversationResult.error ?? orderError ?? settingsResult.error ?? feeResult.error
      ?? (paymentSettingsResult.error?.code === 'PGRST202' ? null : paymentSettingsResult.error)
    if (failure) {
      setError(`Pickup services could not be loaded: ${failure.message}`)
    } else if (locations.some((location) => !(locationResult.data ?? []).some((row) => row.id === location.id && row.name === location.name))) {
      setError('Pickup locations are not fully configured. Apply the Campus Rider pickup migration in Supabase.')
    } else {
      setError('')
      setPickupLocations(locationResult.data ?? [])
      setConversations(conversationResult.data ?? [])
      setOrders((orderRows ?? []).map((order) => ({
        ...order,
        payment_status: paymentColumnMissing ? 'migration_unavailable' as const : order.payment_status ?? 'unpaid',
      })))
      const paymentSettings = paymentSettingsResult.data?.[0]
      if (!paymentSettingsInitialized && !paymentSettingsResult.error) {
        setRiderPaymentSettings({
          upi_id: paymentSettings?.upi_id ?? '',
          payment_qr_path: paymentSettings?.payment_qr_path ?? null,
          payment_enabled: paymentSettings?.payment_enabled ?? false,
        })
        setPaymentSettingsInitialized(true)
      }
      const currentSettings = settingsResult.data?.[0]
      if (currentSettings) {
        const storedFees = (feeResult.data ?? {}) as Partial<Record<PickupLocationId, number>>
        setSettings({ ...currentSettings, pickup_delivery_fees: storedFees })
        if (!settingsInitialized) {
          setDraftLocations(currentSettings.supported_locations ?? [])
          setDraftFees({
            canteen: storedFees.canteen == null ? '' : String(storedFees.canteen),
            cafeteria: storedFees.cafeteria == null ? '' : String(storedFees.cafeteria),
            gate: storedFees.gate == null ? '' : String(storedFees.gate),
          })
          setSettingsInitialized(true)
        }
      }
    }
    setLoading(false)
  }

  const refreshHomeEvent = useEffectEvent(refreshHome)

  useEffect(() => {
    let cancelled = false
    const qrPath = riderPaymentSettings.payment_qr_path
    if (!supabase || !qrPath) return
    void supabase.storage.from(paymentQrBucket).createSignedUrl(qrPath, 1800).then(({ data, error: signedUrlError }) => {
      if (cancelled) return
      if (signedUrlError) {
        if (import.meta.env.DEV) {
          console.error('Could not load the saved rider QR image:', { message: signedUrlError.message })
        }
        setPaymentSettingsError('The saved QR image could not be loaded. Try refreshing or uploading it again.')
        return
      }
      setSavedPaymentQrUrl(data.signedUrl)
    })
    return () => {
      cancelled = true
    }
  }, [riderPaymentSettings.payment_qr_path])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refreshHomeEvent(true), 0)
    const interval = window.setInterval(() => void refreshHomeEvent(), 10000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(interval)
    }
  }, [session.user.id])

  async function loadEvents(id: string, showLoading = false) {
    if (!supabase) return
    if (showLoading) setChatLoading(true)
    const [messageResult, quoteResult] = await Promise.all([
      supabase.from('messages').select('id,sender_id,body,created_at').eq('conversation_id', id).order('created_at'),
      supabase.from('quotes')
        .select('id,item_subtotal,delivery_fee,total_amount,delivery_destination,estimated_minutes,status,created_at,quote_items(id,item_name,quantity,unit_price,line_total)')
        .eq('request_id', id)
        .order('created_at'),
    ])
    const failure = messageResult.error ?? quoteResult.error
    if (failure) {
      setError(`Conversation history could not be loaded: ${failure.message}`)
      setChatLoading(false)
      return
    }
    const nextEvents: ChatEvent[] = [
      ...(messageResult.data ?? []).map((entry) => ({ kind: 'message' as const, id: entry.id, created_at: entry.created_at, message: entry })),
      ...(quoteResult.data ?? []).map((entry) => ({ kind: 'quote' as const, id: entry.id, created_at: entry.created_at, quote: entry })),
    ]
    nextEvents.sort((left, right) => left.created_at.localeCompare(right.created_at))
    setEvents(nextEvents)
    setError('')
    setChatLoading(false)
  }

  const loadEventsEvent = useEffectEvent(loadEvents)

  useEffect(() => {
    if (!conversationId || !supabase) return
    const client = supabase
    const channel = client.channel(`pickup-${conversationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` }, () => void loadEventsEvent(conversationId))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'quotes', filter: `request_id=eq.${conversationId}` }, () => void loadEventsEvent(conversationId))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'delivery_requests', filter: `conversation_id=eq.${conversationId}` }, () => void refreshHomeEvent())
      .subscribe()
    const initialLoad = window.setTimeout(() => void loadEventsEvent(conversationId, true), 0)
    const poll = window.setInterval(() => {
      void loadEventsEvent(conversationId)
      void refreshHomeEvent()
    }, 10000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(poll)
      void client.removeChannel(channel)
    }
  }, [conversationId])

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [events])

  const currentConversation = conversations.find((conversation) => conversation.conversation_id === conversationId) ?? null
  const currentPickup = currentConversation
    ? pickupLocations.find((pickup) => pickup.id === currentConversation.pickup_location_id) ?? null
    : null
  const currentRiderFee = currentConversation && !currentConversation.is_customer
    ? settings.pickup_delivery_fees[currentConversation.pickup_location_id] ?? null
    : null
  const currentRiderFeeIsValid = currentPickup !== null
    && currentRiderFee !== null
    && currentPickup.maximum_rider_delivery_fee !== null
    && currentRiderFee >= Number(currentPickup.minimum_rider_delivery_fee)
    && currentRiderFee <= Number(currentPickup.maximum_rider_delivery_fee)
  const riderEmptyState = getRiderDiscoveryEmptyState(
    riderDiscoveryStatus,
    locations.find((location) => location.id === selectedLocation)?.name ?? 'this pickup point',
  )
  const pickupSettingsComplete = settings.supported_locations.length > 0
    && settings.supported_locations.every((id) => {
      const pickup = pickupLocations.find((entry) => entry.id === id)
      const fee = settings.pickup_delivery_fees[id]
      return pickup !== undefined
        && pickup.maximum_rider_delivery_fee !== null
        && fee !== undefined
        && fee >= Number(pickup.minimum_rider_delivery_fee)
        && fee <= Number(pickup.maximum_rider_delivery_fee)
    })
  const pickupIsOnline = settings.is_online && pickupSettingsComplete
  const missingFeeRangeLocations = draftLocations.filter((id) =>
    pickupLocations.find((pickup) => pickup.id === id)?.maximum_rider_delivery_fee == null,
  )

  async function chooseLocation(locationId: PickupLocationId) {
    const requestId = ++riderSearchId.current
    setSelectedLocation(locationId)
    setRiders([])
    setRiderDiscoveryStatus(null)
    setRiderDiscoveryError('')
    setPage('riders')
    setRidersLoading(true)
    setError('')
    setNotice('')
    if (!supabase) {
      setRiderDiscoveryError('Rider discovery is not configured. Contact the site administrator.')
      setRidersLoading(false)
      return
    }
    const [riderResult, statusResult] = await Promise.all([
      supabase.rpc('list_available_pickup_riders', { location_id: locationId }),
      supabase.rpc('get_pickup_rider_discovery_status', { location_id: locationId }),
    ])
    if (requestId !== riderSearchId.current) return
    if (riderResult.error) {
      if (import.meta.env.DEV) {
        console.error('Pickup rider discovery failed:', { code: riderResult.error.code, message: riderResult.error.message })
      }
      const denied = riderResult.error.code === '42501'
        || /permission denied|not authorized/i.test(riderResult.error.message)
      setRiderDiscoveryError(denied
        ? 'Access to rider discovery was denied. Sign in with a verified NIT Srinagar account and try again.'
        : riderResult.error.code === 'PGRST202'
          ? 'Rider discovery is not configured on Supabase yet. Apply the latest Campus Rider migration.'
          : 'Riders could not be loaded. Please retry in a moment.')
    } else {
      setRiders(riderResult.data ?? [])
      if (statusResult.error) {
        if (import.meta.env.DEV) {
          console.error('Pickup rider availability diagnostics failed:', { code: statusResult.error.code, message: statusResult.error.message })
        }
        if ((riderResult.data ?? []).length === 0) {
          setRiderDiscoveryError(statusResult.error.code === 'PGRST202'
            ? 'No riders were returned, and availability details are not configured. Apply the latest Campus Rider migration.'
            : 'No riders were returned, and their availability could not be diagnosed. Please retry.')
        }
      } else {
        if (isRiderDiscoveryStatus(statusResult.data)) {
          setRiderDiscoveryStatus(statusResult.data)
        } else if ((riderResult.data ?? []).length === 0) {
          setRiderDiscoveryError('No riders were returned, and their availability could not be diagnosed. Please retry.')
        }
      }
    }
    setRidersLoading(false)
  }

  async function openConversation(riderId: string, locationId: PickupLocationId) {
    if (!supabase) return
    setBusy(true)
    setError('')
    setNotice('')
    const { data, error: openError } = await supabase.rpc('open_pickup_conversation', {
      location_id: locationId,
      selected_rider_id: riderId,
    })
    if (openError) {
      setError(openError.message)
      setBusy(false)
      return
    }
    const id = data
    setConversationId(id)
    setEvents([])
    setDestination('')
    setDraftItems([{ key: nextItemKey, name: '', quantity: '1', unitPrice: '' }])
    setEta('')
    setPage('chat')
    await refreshHome()
    await loadEvents(id, true)
    setBusy(false)
  }

  async function openExistingConversation(conversation: ConversationSummary) {
    setConversationId(conversation.conversation_id)
    setSelectedLocation(conversation.pickup_location_id)
    setDestination(conversation.destination ?? '')
    setPage('chat')
    setError('')
    await loadEvents(conversation.conversation_id, true)
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !conversationId || !message.trim() || busy) return
    setBusy(true)
    setError('')
    const { error: sendError } = await supabase.rpc('send_pickup_message', {
      conversation_uuid: conversationId,
      message_body: message.trim(),
    })
    if (sendError) setError(sendError.message)
    else {
      setMessage('')
      await loadEvents(conversationId)
      await refreshHome()
    }
    setBusy(false)
  }

  async function saveRiderSettings(online: boolean) {
    if (!supabase || busy) return
    setRiderSettingsError('')
    const deliveryFees = Object.fromEntries(locations.map(({ id }) => [
      id,
      draftFees[id].trim() ? Number(draftFees[id]) : null,
    ]))
    const feeErrors = locations.flatMap(({ id }) => {
      if (!draftFees[id].trim()) return []
      const limits = pickupLocations.find((pickup) => pickup.id === id)
      if (!limits || limits.maximum_rider_delivery_fee == null) {
        return [`An administrator must configure the maximum delivery fee for ${limits?.name ?? id} before a rider price can be saved.`]
      }
      const amount = Number(draftFees[id])
      if (!Number.isFinite(amount)
        || amount < Number(limits.minimum_rider_delivery_fee)
        || amount > Number(limits.maximum_rider_delivery_fee)
        || Math.round(amount * 100) !== amount * 100
      ) {
        return [`Enter a ${limits.name} fee from ₹${Number(limits.minimum_rider_delivery_fee).toFixed(2)} to ₹${Number(limits.maximum_rider_delivery_fee).toFixed(2)}, with at most two decimal places.`]
      }
      return []
    })
    if (feeErrors.length > 0) {
      setRiderSettingsError(feeErrors[0])
      return
    }
    if (online && draftLocations.length === 0) {
      setRiderSettingsError('Choose at least one pickup point before going online.')
      return
    }
    if (online && draftLocations.some((id) => !draftFees[id].trim())) {
      setRiderSettingsError('Set a delivery fee for every pickup location you want to serve before going online.')
      return
    }
    setBusy(true)
    setRiderSettingsError('')
    setNotice('')
    const { data, error: saveError } = await supabase.rpc('save_rider_pickup_settings', {
      pickup_locations: draftLocations,
      delivery_fees: deliveryFees,
      online,
    })
    if (saveError) {
      if (import.meta.env.DEV) {
        console.error('Saving pickup rider settings failed:', { code: saveError.code, message: saveError.message })
      }
      setRiderSettingsError(saveError.message)
    }
    else {
      const savedFees = Object.fromEntries(
        Object.entries(deliveryFees).filter((entry): entry is [string, number] => entry[1] !== null),
      ) as Partial<Record<PickupLocationId, number>>
      setSettings((current) => ({
        ...current,
        is_online: data,
        supported_locations: draftLocations,
        pickup_delivery_fees: savedFees,
      }))
      setSettingsInitialized(true)
      setNotice(data ? 'You are online for the selected pickup locations.' : 'You are now offline for pickup requests.')
      await refreshHome()
    }
    setBusy(false)
  }

  async function createQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !conversationId || busy) return
    const cleanItems = draftItems.map((item) => ({
      name: item.name.trim(),
      quantity: Number(item.quantity),
      unit_price: Number(item.unitPrice),
    }))
    if (cleanItems.some((item, index) => !draftItems[index].unitPrice.trim() || !item.name || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99 || !Number.isFinite(item.unit_price) || item.unit_price < 0)) {
      setError('Enter an item name, a quantity from 1 to 99, and a non-negative unit price for every row.')
      return
    }
    setBusy(true)
    setError('')
    const { error: quoteError } = await supabase.rpc('create_pickup_quote', {
      conversation_uuid: conversationId,
      items: cleanItems,
      delivery_destination: destination.trim() || null,
      estimated_minutes: eta ? Number(eta) : null,
    })
    if (quoteError) setError(quoteError.message)
    else {
      setNotice('Your itemized quote has been sent to the customer.')
      setDraftItems([{ key: nextItemKey, name: '', quantity: '1', unitPrice: '' }])
      setNextItemKey((key) => key + 1)
      setEta('')
      await loadEvents(conversationId)
      await refreshHome()
    }
    setBusy(false)
  }

  async function respondToQuote(quoteId: string, accept: boolean) {
    if (!supabase || busy) return
    setBusy(true)
    setError('')
    const { error: responseError } = await supabase.rpc('respond_to_pickup_quote', {
      quote_uuid: quoteId,
      accept_quote: accept,
      destination: destination.trim() || null,
    })
    if (responseError) setError(responseError.message)
    else {
      setNotice(accept ? 'Quote accepted. The order is now confirmed with the rider.' : 'Quote rejected. Message the rider if you would like a revision.')
      if (conversationId) await loadEvents(conversationId)
      await refreshHome()
    }
    setBusy(false)
  }

  async function updateOrder(orderId: string, nextStatus: string) {
    if (!supabase || busy) return
    setBusy(true)
    setError('')
    const { error: statusError } = await supabase.rpc('update_pickup_order_status', { order_uuid: orderId, next_status: nextStatus })
    if (statusError) setError(statusError.message)
    else {
      setNotice(`Order status updated: ${orderSteps[nextStatus] ?? nextStatus}.`)
      await refreshHome()
    }
    setBusy(false)
  }

  async function saveRiderPaymentSettings() {
    if (!supabase || paymentSettingsBusy) return
    setPaymentSettingsError('')
    setPaymentSettingsNotice('')
    const upiId = riderPaymentSettings.upi_id.trim()
    if (upiId && !validUpiId.test(upiId)) {
      setPaymentSettingsError('Enter a valid UPI ID, for example name@bank, or leave it blank.')
      return
    }
    const willHaveQr = paymentQrFile !== null || (!removeSavedPaymentQr && riderPaymentSettings.payment_qr_path !== null)
    if (riderPaymentSettings.payment_enabled && !upiId && !willHaveQr) {
      setPaymentSettingsError('Add a UPI ID or upload a QR image before enabling UPI payments.')
      return
    }
    if (paymentQrFile && (!['image/png', 'image/jpeg', 'image/webp'].includes(paymentQrFile.type)
      || paymentQrFile.size > maximumPaymentQrSize
      || !(await hasValidPaymentQrImageSignature(paymentQrFile)))) {
      setPaymentSettingsError('Choose a valid PNG, JPG, or WebP image no larger than 5 MB.')
      return
    }

    setPaymentSettingsBusy(true)
    const objectPath = `${session.user.id}/payment-qr`
    if (paymentQrFile) {
      const { error: uploadError } = await supabase.storage.from(paymentQrBucket).upload(objectPath, paymentQrFile, {
        cacheControl: '3600',
        contentType: paymentQrFile.type,
        upsert: true,
      })
      if (uploadError) {
        if (import.meta.env.DEV) console.error('Rider payment QR upload failed:', { message: uploadError.message })
        setPaymentSettingsError('The QR image could not be uploaded. Check your connection and try again.')
        setPaymentSettingsBusy(false)
        return
      }
    } else if (removeSavedPaymentQr && riderPaymentSettings.payment_qr_path) {
      const { error: removeError } = await supabase.storage.from(paymentQrBucket).remove([objectPath])
      if (removeError) {
        if (import.meta.env.DEV) console.error('Rider payment QR removal failed:', { message: removeError.message })
        setPaymentSettingsError('The saved QR image could not be removed. Try again.')
        setPaymentSettingsBusy(false)
        return
      }
    }

    const { error: saveError } = await supabase.rpc('save_my_rider_payment_settings', {
      configured_upi_id: upiId || null,
      enable_payments: riderPaymentSettings.payment_enabled,
    })
    if (saveError) {
      if (import.meta.env.DEV) console.error('Saving rider payment settings failed:', { code: saveError.code, message: saveError.message })
      setPaymentSettingsError(saveError.message)
    } else {
      const nextQrPath = paymentQrFile
        ? objectPath
        : removeSavedPaymentQr
          ? null
          : riderPaymentSettings.payment_qr_path
      setRiderPaymentSettings({ ...riderPaymentSettings, upi_id: upiId, payment_qr_path: nextQrPath })
      updatePaymentQrFile(null)
      setRemoveSavedPaymentQr(false)
      if (!nextQrPath) setSavedPaymentQrUrl('')
      else if (paymentQrFile) {
        const { data: signedData, error: signedError } = await supabase.storage.from(paymentQrBucket).createSignedUrl(nextQrPath, 1800)
        if (signedError) {
          if (import.meta.env.DEV) console.error('Could not load the saved rider QR image:', { message: signedError.message })
          setPaymentSettingsError('Payment settings were saved, but the QR preview could not be refreshed.')
        } else setSavedPaymentQrUrl(signedData.signedUrl)
      }
      setPaymentSettingsInitialized(true)
      setPaymentSettingsNotice('Payment settings saved. UPI payments are manual and are not verified by Campus Rider.')
      await refreshHome()
    }
    setPaymentSettingsBusy(false)
  }

  async function openOrderPayment(orderId: string) {
    if (!supabase) return
    if (!paymentOrderId && document.activeElement instanceof HTMLElement) {
      paymentReturnFocusRef.current = document.activeElement
    }
    setPaymentOrderId(orderId)
    setPaymentDetails(null)
    setPaymentQrDataUrl('')
    setPaymentError('')
    setPaymentActionNotice('')
    setCopyNotice('')
    setPaymentLoading(true)

    const { data, error: detailsError } = await supabase.rpc('get_pickup_order_payment_details', { order_uuid: orderId })
    const details = data?.[0] as OrderPaymentDetails | undefined
    if (detailsError || !details) {
      if (detailsError && import.meta.env.DEV) {
        console.error('Loading authorized pickup payment details failed:', { code: detailsError.code, message: detailsError.message })
      }
      setPaymentError(detailsError?.code === 'PGRST202'
        ? 'Payment features are not installed on Supabase yet. Apply the latest payment migration.'
        : 'Payment details could not be loaded for this order.')
      setPaymentLoading(false)
      return
    }
    setPaymentDetails(details)
    try {
      const upiUri = buildOrderUpiUri(details)
      if (upiUri) {
        setPaymentQrDataUrl(await QRCode.toDataURL(upiUri, { errorCorrectionLevel: 'M', margin: 2, width: 360 }))
      } else if (details.rider_qr_path) {
        const { data: signedData, error: signedError } = await supabase.storage
          .from(paymentQrBucket)
          .createSignedUrl(details.rider_qr_path, 600)
        if (signedError) throw signedError
        setPaymentQrDataUrl(signedData.signedUrl)
      }
    } catch (qrError) {
      if (import.meta.env.DEV) {
        console.error('Preparing order payment QR failed:', qrError instanceof Error ? qrError.message : 'Unknown QR error')
      }
      setPaymentError('The rider’s QR code could not be prepared. Try again or contact the rider.')
    }
    setPaymentLoading(false)
  }

  function closeOrderPayment() {
    setPaymentOrderId(null)
    setPaymentDetails(null)
    setPaymentQrDataUrl('')
  }

  async function reportPaymentMade() {
    if (!supabase || !paymentDetails || paymentActionBusy) return
    setPaymentActionBusy(true)
    setPaymentError('')
    const { error: reportError } = await supabase.rpc('report_pickup_order_payment', { order_uuid: paymentDetails.order_id })
    if (reportError) {
      if (import.meta.env.DEV) console.error('Reporting pickup payment failed:', { code: reportError.code, message: reportError.message })
      setPaymentError('Your payment report could not be saved. Please retry.')
    } else {
      const orderId = paymentDetails.order_id
      await refreshHome()
      await openOrderPayment(orderId)
      setPaymentActionNotice('Payment reported. It remains unverified until the assigned rider confirms receipt.')
    }
    setPaymentActionBusy(false)
  }

  async function confirmPaymentReceived() {
    if (!supabase || !paymentDetails || paymentActionBusy) return
    setPaymentActionBusy(true)
    setPaymentError('')
    const { error: confirmError } = await supabase.rpc('confirm_pickup_order_payment', { order_uuid: paymentDetails.order_id })
    if (confirmError) {
      if (import.meta.env.DEV) console.error('Confirming pickup payment failed:', { code: confirmError.code, message: confirmError.message })
      setPaymentError('Payment receipt could not be confirmed. Only the assigned rider can confirm it after checking their UPI app.')
    } else {
      const orderId = paymentDetails.order_id
      await refreshHome()
      await openOrderPayment(orderId)
      setPaymentActionNotice('Receipt confirmed by the assigned rider. Campus Rider does not independently verify UPI transfers.')
    }
    setPaymentActionBusy(false)
  }

  async function copyUpiId(upiId: string) {
    try {
      await navigator.clipboard.writeText(upiId)
      setCopyNotice('UPI ID copied.')
    } catch {
      setCopyNotice('Could not copy automatically. Select and copy the UPI ID above.')
    }
  }

  function toggleDraftLocation(locationId: PickupLocationId) {
    setDraftLocations((current) => current.includes(locationId)
      ? current.filter((existing) => existing !== locationId)
      : [...current, locationId])
  }

  function addQuoteItem() {
    setDraftItems((current) => [...current, { key: nextItemKey, name: '', quantity: '1', unitPrice: '' }])
    setNextItemKey((key) => key + 1)
  }

  function updateQuoteItem(key: number, field: 'name' | 'quantity' | 'unitPrice', value: string) {
    setDraftItems((current) => current.map((item) => item.key === key ? { ...item, [field]: value } : item))
  }

  if (previewMode) {
    return <section className="pickup-workspace"><div className="pickup-alert"><CircleHelp size={17} /> Rider discovery and chat use live, permission-checked Supabase data and are unavailable in demo preview mode.</div></section>
  }

  return (
    <section className="pickup-workspace" aria-label="Pickup locations and rider requests">
      {page !== 'locations' && (
        <button className="pickup-back" type="button" onClick={() => { setPage('locations'); setError(''); setNotice('') }}>
          <ArrowLeft size={15} /> Back to pickup locations
        </button>
      )}
      {error && <div className="pickup-alert error" role="alert"><CircleHelp size={16} />{error}<button type="button" onClick={() => void refreshHome(true)}>Retry</button></div>}
      {notice && <div className="pickup-alert success" role="status"><Check size={16} />{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice('')}><X size={15} /></button></div>}

      {page === 'locations' && (
        <>
          <div className="pickup-heading">
            <div><span className="section-eyebrow">REQUEST A CAMPUS PICKUP</span><h2>Where should we meet?</h2><p>Choose a pickup point to find a currently available rider.</p></div>
            <button className="pickup-refresh" type="button" onClick={() => void refreshHome(true)} disabled={loading} aria-label="Refresh pickup data"><LoaderCircle size={16} /></button>
          </div>
          <div className="pickup-location-grid">
            {locations.map(({ id, name, description, Icon }) => (
              <article className="pickup-location-card" key={id}>
                <span className="pickup-location-icon"><Icon size={22} /></span>
                <h3>{name}</h3><p>{description}</p>
                <button type="button" onClick={() => void chooseLocation(id)} disabled={loading}>
                  Find Riders <ArrowRight size={15} />
                </button>
              </article>
            ))}
          </div>

          <section className="pickup-rider-settings">
            <div className="pickup-section-heading"><div><span className="section-eyebrow">RIDER WORKSPACE</span><h3>Offer pickup help</h3><p>Choose the pickup points you can deliver from, set a charge for each one, and go online when ready.</p></div><span className={`pickup-status ${pickupIsOnline ? 'online' : ''}`}><i />{pickupIsOnline ? 'ONLINE' : settings.is_online && !pickupSettingsComplete ? 'SETUP REQUIRED' : 'OFFLINE'}</span></div>
            {missingFeeRangeLocations.length > 0 && <div className="pickup-settings-message" role="status">
              An administrator must set an approved fee range for {missingFeeRangeLocations.map((id) => locations.find((location) => location.id === id)?.name ?? id).join(', ')} in Supabase before prices can be saved. Your account is not online for pickup requests until this setup is complete.
            </div>}
            {riderSettingsError && <div className="pickup-settings-error" role="alert"><CircleHelp size={15} />{riderSettingsError}</div>}
            <div className="pickup-fee-settings" aria-label="Rider delivery charges">
              {locations.map(({ id, name }) => {
                const limits = pickupLocations.find((pickup) => pickup.id === id)
                return <label className="pickup-fee-field" key={id}>
                  <span>{name} delivery charge (INR)</span>
                  {limits?.maximum_rider_delivery_fee == null
                    ? <small>An administrator must configure the allowed fee range.</small>
                    : <small>Allowed: ₹{Number(limits.minimum_rider_delivery_fee).toFixed(2)}–₹{Number(limits.maximum_rider_delivery_fee).toFixed(2)}</small>}
                  <input
                    type="number"
                    min={limits?.minimum_rider_delivery_fee ?? 0}
                    max={limits?.maximum_rider_delivery_fee ?? undefined}
                    step="0.01"
                    inputMode="decimal"
                    value={draftFees[id]}
                    onChange={(event) => setDraftFees((current) => ({ ...current, [id]: event.target.value }))}
                    placeholder={limits?.maximum_rider_delivery_fee == null ? 'Admin setup required' : 'Enter your fee'}
                    aria-label={`${name} delivery charge in Indian rupees`}
                    disabled={busy || limits?.maximum_rider_delivery_fee == null}
                  />
                </label>
              })}
            </div>
            <div className="pickup-location-options" aria-label="Pickup points available for delivery">
              <span className="pickup-source-label">I can deliver from</span>
              {locations.map(({ id, name }) => (
                <label key={id}><input type="checkbox" checked={draftLocations.includes(id)} onChange={() => toggleDraftLocation(id)} disabled={busy} />Deliver from {name}</label>
              ))}
            </div>
            <div className="pickup-rider-settings-actions">
              <span>{settings.workload} of {settings.capacity} active requests</span>
              <button type="button" onClick={() => void saveRiderSettings(!pickupIsOnline)} disabled={busy}>
                {busy ? 'Saving…' : pickupIsOnline ? 'Stop Accepting Requests' : 'Start Delivering'}
              </button>
              <button className="pickup-secondary-button" type="button" onClick={() => void saveRiderSettings(pickupIsOnline)} disabled={busy}>Save rider settings</button>
            </div>
          </section>

          <section className="pickup-rider-settings payment-settings">
            <div className="pickup-section-heading"><div><span className="section-eyebrow">OPTIONAL CUSTOMER PAYMENT</span><h3>Payment Settings</h3><p>Customers can pay you directly by UPI after accepting your quote. Campus Rider does not process or verify transfers.</p></div><span className={`pickup-status ${riderPaymentSettings.payment_enabled ? 'online' : ''}`}><i />{riderPaymentSettings.payment_enabled ? 'ENABLED' : 'DISABLED'}</span></div>
            {paymentMigrationMissing && <div className="pickup-settings-message" role="status">Apply the latest payment migration in Supabase before enabling UPI payment features. Rider availability, pickup requests, and chat remain available.</div>}
            {paymentSettingsError && <div className="pickup-settings-error" role="alert"><CircleHelp size={15} />{paymentSettingsError}</div>}
            {paymentSettingsNotice && <div className="pickup-settings-message payment-settings-success" role="status"><Check size={15} />{paymentSettingsNotice}</div>}
            <label className="payment-upi-field">UPI ID (optional fallback)
              <input
                type="text"
                autoComplete="off"
                maxLength={320}
                value={riderPaymentSettings.upi_id}
                onChange={(event) => setRiderPaymentSettings((current) => ({ ...current, upi_id: event.target.value }))}
                placeholder="name@bank"
                disabled={paymentSettingsBusy || paymentMigrationMissing}
              />
              <small>Only the UPI ID format is checked; Campus Rider cannot verify who owns that account.</small>
            </label>
            <div className="payment-qr-controls">
              <label className="payment-qr-upload">Upload UPI QR image
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={paymentSettingsBusy || paymentMigrationMissing}
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null
                    if (file && (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > maximumPaymentQrSize)) {
                      setPaymentSettingsError('Choose a PNG, JPG, or WebP image no larger than 5 MB.')
                      event.target.value = ''
                      return
                    }
                    setPaymentSettingsError('')
                    updatePaymentQrFile(file)
                    setRemoveSavedPaymentQr(false)
                  }}
                />
                <small>PNG, JPG, or WebP; maximum 5 MB. Stored privately.</small>
              </label>
              {(paymentQrPreviewUrl || (!removeSavedPaymentQr && savedPaymentQrUrl)) && (
                <div className="payment-qr-preview">
                  <img src={paymentQrPreviewUrl || savedPaymentQrUrl} alt="Preview of your UPI payment QR code" />
                  <span>{paymentQrPreviewUrl ? 'Unsaved preview' : 'Saved QR code'}</span>
                  {riderPaymentSettings.payment_qr_path && !removeSavedPaymentQr && <button type="button" disabled={paymentSettingsBusy || paymentMigrationMissing} onClick={() => { setRemoveSavedPaymentQr(true); updatePaymentQrFile(null); setSavedPaymentQrUrl('') }}>Remove saved QR</button>}
                  {paymentQrFile && <button type="button" disabled={paymentSettingsBusy || paymentMigrationMissing} onClick={() => updatePaymentQrFile(null)}>Clear new image</button>}
                </div>
              )}
            </div>
            <label className="payment-enable-option"><input type="checkbox" checked={riderPaymentSettings.payment_enabled} onChange={(event) => setRiderPaymentSettings((current) => ({ ...current, payment_enabled: event.target.checked }))} disabled={paymentSettingsBusy || paymentMigrationMissing} />Enable UPI payment details for accepted orders</label>
            <div className="payment-settings-footer"><span>Enable only after checking the UPI ID or QR recipient yourself.</span><button type="button" onClick={() => void saveRiderPaymentSettings()} disabled={paymentSettingsBusy || loading || paymentMigrationMissing}>{paymentSettingsBusy ? 'Saving…' : 'Save payment settings'}</button></div>
          </section>

          <section className="pickup-list-section">
            <div className="pickup-section-heading"><div><span className="section-eyebrow">YOUR REQUESTS</span><h3>Conversations</h3></div></div>
            {loading ? <div className="pickup-loading"><LoaderCircle size={18} /> Loading your conversations…</div> : conversations.length === 0
              ? <p className="pickup-empty-line">Your rider chats and requests will appear here.</p>
              : <div className="pickup-conversation-list">{conversations.map((conversation) => (
                <button type="button" className="pickup-conversation-row" key={conversation.conversation_id} onClick={() => void openExistingConversation(conversation)}>
                  <span className="pickup-conversation-icon"><MessageCircle size={17} /></span>
                  <span className="pickup-conversation-copy"><strong>{conversation.pickup_name} · {conversation.other_person_name}</strong><small>{conversation.last_message ?? 'Conversation started'}{conversation.request_status ? ` · ${conversation.request_status}` : ''}</small></span>
                  <ArrowRight size={16} />
                </button>
              ))}</div>}
          </section>

          <section className="pickup-list-section">
            <div className="pickup-section-heading"><div><span className="section-eyebrow">CONFIRMED REQUESTS</span><h3>Pickup orders</h3></div></div>
            {loading ? <div className="pickup-loading"><LoaderCircle size={18} /> Loading orders…</div> : orders.length === 0
              ? <p className="pickup-empty-line">Accepted quotes become trackable pickup orders here.</p>
              : <div className="pickup-order-list">{orders.map((order) => {
                const isRider = order.delivery_partner_id === session.user.id
                const next = order.status === 'accepted' ? 'collecting' : order.status === 'collecting' ? 'collected' : order.status === 'collected' ? 'on_the_way' : order.status === 'on_the_way' ? 'delivered' : null
                return <article className="pickup-order-card" key={order.id}>
                  <div className="pickup-order-top"><strong>{locations.find((location) => location.id === order.pickup_location_id)?.name ?? 'Pickup'}</strong><span className="pickup-order-status">{orderSteps[order.status] ?? order.status}</span></div>
                  <p>Deliver to {order.delivery_location}</p>
                  <small>{order.order_items.map((item) => `${item.quantity} × ${item.product_name}`).join(' · ')}</small>
                  <small className="pickup-payment-note">Payment: {order.payment_status === 'migration_unavailable' ? 'Unavailable until the payment migration is applied' : order.payment_status === 'paid' ? 'Rider-confirmed' : order.payment_status === 'payment_reported' ? 'Reported by customer · awaiting rider confirmation' : 'Unpaid'}. Campus Rider does not process or verify transfers.</small>
                  <div className="pickup-order-bottom"><span>Accepted total <strong>₹{Number(order.total_amount).toFixed(2)}</strong>{order.delivery_fee !== null && <small> (₹{Number(order.delivery_fee).toFixed(2)} delivery)</small>}</span>
                    <button type="button" onClick={() => void openOrderPayment(order.id)}>Pay / payment details</button>
                    {isRider && next && <button type="button" onClick={() => void updateOrder(order.id, next)} disabled={busy}>{next === 'delivered' ? 'Mark delivered' : `Mark ${orderSteps[next]?.toLowerCase()}`}</button>}
                    {order.status === 'accepted' && <button className="pickup-cancel-button" type="button" onClick={() => void updateOrder(order.id, 'cancelled')} disabled={busy}>Cancel</button>}
                  </div>
                </article>
              })}</div>}
          </section>
        </>
      )}

      {page === 'riders' && selectedLocation && (
        <>
          <div className="pickup-heading">
            <div><span className="section-eyebrow">PICKUP LOCATION</span><h2>{locations.find((location) => location.id === selectedLocation)?.name}</h2><p>Only verified riders online for this location and under capacity are listed.</p></div>
            <button className="pickup-refresh" type="button" onClick={() => void chooseLocation(selectedLocation)} disabled={ridersLoading} aria-label="Refresh available riders"><LoaderCircle size={16} /></button>
          </div>
          {ridersLoading ? <div className="pickup-loading"><LoaderCircle size={20} /> Finding available riders…</div>
            : riderDiscoveryError ? <div className="pickup-alert error" role="alert"><CircleHelp size={16} />{riderDiscoveryError}<button type="button" onClick={() => void chooseLocation(selectedLocation)}>Retry</button></div>
              : riders.length === 0 ? <div className="pickup-empty-state"><span><Bike size={23} /></span><h3>{riderEmptyState.title}</h3><p>{riderEmptyState.message}</p></div>
              : <div className="pickup-rider-grid">{riders.map((rider) => (
                <article className="pickup-rider-card" key={rider.rider_id}>
                  <div className="pickup-rider-profile">{rider.avatar_url ? <img src={rider.avatar_url} alt="" /> : <span>{rider.full_name.charAt(0).toUpperCase()}</span>}<div><strong>{rider.full_name}</strong><small><i /> Online · available</small></div></div>
                  <div className="pickup-rider-verified"><ShieldCheck size={14} /> Verified NIT Srinagar student</div>
                  <div className="pickup-rider-facts"><span>Active workload</span><strong>{rider.workload} / {rider.capacity}</strong><span>Rider delivery charge</span><strong>₹{Number(rider.delivery_fee).toFixed(2)}</strong></div>
                  <button className="pickup-chat-button" type="button" onClick={() => void openConversation(rider.rider_id, selectedLocation)} disabled={busy}>
                    {busy ? 'Opening chat…' : 'Chat with Rider'} <MessageCircle size={15} />
                  </button>
                </article>
              ))}</div>}
        </>
      )}

      {page === 'chat' && (
        <section className="pickup-chat-panel" aria-label="Private rider conversation">
          <header className="pickup-chat-header"><span className="pickup-chat-icon"><MessageCircle size={17} /></span><div><strong>{currentConversation?.other_person_name ?? 'Campus Rider student'}</strong><small>{currentConversation?.pickup_name ?? 'Pickup'} · private conversation</small></div><span className={`pickup-chat-state ${currentConversation?.conversation_status === 'open' ? 'open' : ''}`}>{currentConversation?.conversation_status === 'open' ? 'OPEN' : 'ORDER CONFIRMED'}</span></header>
          <div className="pickup-chat-events">
            {chatLoading ? <div className="pickup-loading"><LoaderCircle size={18} /> Loading conversation…</div> : events.length === 0 && !error && <div className="pickup-chat-empty"><MessageCircle size={23} /><strong>Start the conversation</strong><span>Describe the items you need and where to deliver them.</span></div>}
            {!chatLoading && events.map((event) => event.kind === 'message'
              ? <div key={event.id} className={`pickup-message ${event.message.sender_id === session.user.id ? 'mine' : ''}`}><div className="pickup-message-byline"><strong>{event.message.sender_id === session.user.id ? 'You' : currentConversation?.other_person_name ?? 'Campus Rider student'}</strong><time>{formatTime(event.created_at)}</time></div><p>{event.message.body}</p></div>
              : <article key={event.id} className={`pickup-quote-card ${event.quote.status}`}>
                <div className="pickup-quote-heading"><strong>Itemized quote</strong><span>{event.quote.status}</span></div>
                <div className="pickup-quote-items">{event.quote.quote_items.map((item) => <div key={item.id}><span>{item.quantity} × {item.item_name}</span><strong>₹{Number(item.line_total).toFixed(2)}</strong><small>₹{Number(item.unit_price).toFixed(2)} each</small></div>)}</div>
                <div className="pickup-quote-total"><span>Items subtotal</span><strong>₹{Number(event.quote.item_subtotal).toFixed(2)}</strong><span>Rider delivery charge</span><strong>₹{Number(event.quote.delivery_fee).toFixed(2)}</strong>{event.quote.delivery_destination && <><span>Destination</span><strong>{event.quote.delivery_destination}</strong></>}{event.quote.estimated_minutes && <><span>Estimated time</span><strong><Clock3 size={13} /> About {event.quote.estimated_minutes} min</strong></>}<b>Total amount</b><b>₹{Number(event.quote.total_amount).toFixed(2)}</b></div>
                {currentConversation?.is_customer && event.quote.status === 'proposed' && <div className="pickup-quote-actions"><label>Delivery destination<input value={destination || event.quote.delivery_destination || currentConversation.destination || ''} onChange={(inputEvent) => setDestination(inputEvent.target.value)} placeholder="Hostel and room" maxLength={240} /></label><button type="button" onClick={() => void respondToQuote(event.quote.id, false)} disabled={busy}>Reject</button><button type="button" onClick={() => void respondToQuote(event.quote.id, true)} disabled={busy}>Accept quote</button></div>}
                {event.quote.status === 'accepted' && orders.some((order) => order.accepted_quote_id === event.quote.id) && <button className="payment-chat-link" type="button" onClick={() => {
                  const acceptedOrder = orders.find((order) => order.accepted_quote_id === event.quote.id)
                  if (acceptedOrder) void openOrderPayment(acceptedOrder.id)
                }}><CreditCard size={14} /> Open order payment details</button>}
                <p className="pickup-payment-note">Campus Rider records the agreed amount but does not collect or process payment.</p>
              </article>)}
            <div ref={timelineEnd} />
          </div>
          {currentConversation?.is_customer === false && currentConversation.conversation_status === 'open' && (currentConversation.request_status === 'pending' || currentConversation.request_status === 'rejected') && !currentRiderFeeIsValid
            ? <div className="pickup-fee-note pickup-unconfigured-fee">A quote cannot be sent until your delivery charge is configured within the administrator-approved range for this pickup location.</div>
            : currentConversation?.is_customer === false && currentConversation.conversation_status === 'open' && (currentConversation.request_status === 'pending' || currentConversation.request_status === 'rejected') && (
            <form className="pickup-quote-form" onSubmit={(event) => void createQuote(event)}>
              <div className="pickup-quote-form-heading"><div><span className="section-eyebrow">RIDER RESPONSE</span><strong>Create itemized quote</strong></div><span>Rider delivery charge: ₹{Number(currentRiderFee).toFixed(2)}</span></div>
              {draftItems.map((item) => <div className="pickup-quote-draft-row" key={item.key}><input aria-label="Item name" value={item.name} onChange={(event) => updateQuoteItem(item.key, 'name', event.target.value)} placeholder="Item name" maxLength={120} required /><input aria-label="Quantity" type="number" min="1" max="99" value={item.quantity} onChange={(event) => updateQuoteItem(item.key, 'quantity', event.target.value)} required /><input aria-label="Unit price" type="number" min="0" step="0.01" value={item.unitPrice} onChange={(event) => updateQuoteItem(item.key, 'unitPrice', event.target.value)} placeholder="₹ price" required />{draftItems.length > 1 && <button className="pickup-remove-item" type="button" onClick={() => setDraftItems((current) => current.filter((existing) => existing.key !== item.key))} aria-label="Remove item"><Trash2 size={14} /></button>}</div>)}
              <div className="pickup-quote-draft-footer"><button className="pickup-add-item" type="button" onClick={addQuoteItem}><Plus size={14} /> Add item</button><label>Destination (if known)<input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder={currentConversation.destination ?? 'Hostel and room'} maxLength={240} /></label><label>ETA (minutes)<input type="number" min="1" max="240" value={eta} onChange={(event) => setEta(event.target.value)} placeholder="Optional" /></label></div>
              <button className="pickup-send-quote" type="submit" disabled={busy}>{busy ? 'Sending quote…' : 'Send quote'} <ArrowRight size={15} /></button>
            </form>
          )}
          {currentConversation?.conversation_status === 'open' && <form className="pickup-message-form" onSubmit={(event) => void sendMessage(event)}><textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={2000} placeholder="Write a message about items, quantities, or pickup instructions…" aria-label="Message" disabled={busy} /><button type="submit" disabled={busy || !message.trim()} aria-label="Send message">{busy ? <LoaderCircle size={17} /> : <Send size={17} />}</button></form>}
          <footer className="pickup-chat-footer"><MapPin size={13} /> Messages are private to the customer and selected rider.</footer>
        </section>
      )}
      {paymentOrderId && (
        <div className="payment-modal-backdrop" onClick={(event) => {
          if (event.target === event.currentTarget) closeOrderPayment()
        }} onKeyDown={(event) => {
          if (event.key === 'Escape') closeOrderPayment()
        }}>
          <section ref={paymentModalRef} className="payment-modal" role="dialog" aria-modal="true" aria-labelledby="pickup-payment-title" tabIndex={-1}>
            <header className="payment-modal-header">
              <div><span className="section-eyebrow">ACCEPTED PICKUP ORDER</span><h2 id="pickup-payment-title">Order payment</h2></div>
              <button type="button" onClick={closeOrderPayment} aria-label="Close payment details"><X size={19} /></button>
            </header>
            {paymentLoading ? <div className="pickup-loading"><LoaderCircle size={18} /> Loading authorized payment details…</div>
              : paymentError && !paymentDetails ? <div className="pickup-settings-error" role="alert"><CircleHelp size={15} />{paymentError}</div>
                : paymentDetails && (
                  <>
                    {paymentError && <div className="pickup-settings-error" role="alert"><CircleHelp size={15} />{paymentError}</div>}
                    {paymentActionNotice && <div className="pickup-settings-message payment-settings-success" role="status">{paymentActionNotice}</div>}
                    <div className="payment-order-summary">
                      <strong>Deliver to {orders.find((order) => order.id === paymentDetails.order_id)?.delivery_location ?? 'your campus location'}</strong>
                      {(orders.find((order) => order.id === paymentDetails.order_id)?.order_items ?? []).map((item, index) => (
                        <div key={`${item.product_name}-${index}`}><span>{item.quantity} × {item.product_name}</span><span>₹{formatAcceptedLineAmount(item.quantity, item.unit_price)}</span></div>
                      ))}
                      <div><span>Item subtotal</span><span>₹{Number(paymentDetails.item_subtotal).toFixed(2)}</span></div>
                      <div><span>Agreed delivery charge</span><span>₹{Number(paymentDetails.delivery_fee).toFixed(2)}</span></div>
                      <div className="payment-order-total"><strong>Total due (INR)</strong><strong>₹{Number(paymentDetails.total_amount).toFixed(2)}</strong></div>
                    </div>
                    <p className="payment-state-note">
                      Payment status: <strong>{paymentDetails.payment_status === 'paid' ? 'Rider-confirmed' : paymentDetails.payment_status === 'payment_reported' ? 'Reported by customer · awaiting rider confirmation' : 'Unpaid'}</strong>
                      {paymentDetails.payment_reported_at && <> · Reported {formatTime(paymentDetails.payment_reported_at)}</>}
                      {paymentDetails.payment_confirmed_at && <> · Confirmed {formatTime(paymentDetails.payment_confirmed_at)}</>}
                    </p>
                    {paymentDetails.rider_upi_id || paymentDetails.rider_qr_path ? (
                      <div className="payment-qr-panel">
                        <h3><CreditCard size={16} /> Pay via UPI QR</h3>
                        {paymentQrDataUrl
                          ? <a className="payment-qr-image-link" href={paymentQrDataUrl} target="_blank" rel="noreferrer" aria-label="Open payment QR at full size">
                            <img className="payment-customer-qr" src={paymentQrDataUrl} alt={`UPI payment QR for ₹${Number(paymentDetails.total_amount).toFixed(2)}, payable to ${paymentDetails.rider_name}`} />
                          </a>
                          : <div className="pickup-loading"><LoaderCircle size={18} /> Preparing payment QR…</div>}
                        <p>Pay exactly <strong>₹{Number(paymentDetails.total_amount).toFixed(2)}</strong> to {paymentDetails.rider_name}. Verify the recipient and amount in your UPI app before paying.</p>
                        {paymentDetails.rider_upi_id
                          ? <>                          <label className="payment-upi-copy">Rider-provided UPI ID<input readOnly value={paymentDetails.rider_upi_id} aria-label="Rider UPI ID" /><button type="button" onClick={() => void copyUpiId(paymentDetails.rider_upi_id ?? '')}><Copy size={14} /> Copy UPI ID</button></label>
                            {copyNotice && <p className="payment-copy-notice" role="status">{copyNotice}</p>}
                            <a className="payment-open-upi" href={buildOrderUpiUri(paymentDetails) ?? undefined}>Open in UPI app <ExternalLink size={14} /></a>
                            <small>The QR is generated locally for this order’s exact accepted total. The UPI ID and account ownership are rider-provided and are not verified by Campus Rider.</small></>
                          : <small>This uploaded QR may not prefill the order amount. Confirm the recipient and enter exactly ₹{Number(paymentDetails.total_amount).toFixed(2)} in your UPI app. Campus Rider does not verify the recipient.</small>}
                      </div>
                    ) : <p className="payment-state-note">The rider has not enabled UPI payment details. Contact them through the private chat to arrange payment.</p>}
                    {paymentDetails.rider_id === session.user.id && paymentDetails.payment_status === 'payment_reported' && (
                      <button className="payment-confirm-button" type="button" onClick={() => void confirmPaymentReceived()} disabled={paymentActionBusy}>
                        {paymentActionBusy ? 'Saving…' : 'Confirm payment received'}
                      </button>
                    )}
                    {paymentDetails.rider_id !== session.user.id && paymentDetails.payment_status === 'unpaid' && (
                      <button className="payment-report-button" type="button" onClick={() => void reportPaymentMade()} disabled={paymentActionBusy}>
                        {paymentActionBusy ? 'Saving…' : 'I have paid'}
                      </button>
                    )}
                    <p className="payment-manual-warning">Reporting payment does not mark it paid. Only the assigned rider can confirm after checking their own UPI app; Campus Rider does not independently verify transfers.</p>
                  </>
                )}
          </section>
        </div>
      )}
    </section>
  )
}
