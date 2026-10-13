import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bike,
  Check,
  CircleHelp,
  Clock3,
  Coffee,
  DoorOpen,
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
  delivery_location: string
  created_at: string
  pickup_location_id: PickupLocationId | null
  accepted_quote_id: string | null
  delivery_partner_id: string | null
  order_items: { product_name: string; quantity: number; unit_price: number }[]
}
type DraftItem = { key: number; name: string; quantity: string; unitPrice: string }

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

export default function PickupWorkspace({ session, previewMode }: { session: Session; previewMode: boolean }) {
  const [page, setPage] = useState<PickupPage>('locations')
  const [selectedLocation, setSelectedLocation] = useState<PickupLocationId | null>(null)
  const [riders, setRiders] = useState<Rider[]>([])
  const [ridersLoading, setRidersLoading] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [pickupLocations, setPickupLocations] = useState<PickupLocation[]>([])
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [orders, setOrders] = useState<PickupOrder[]>([])
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
  const [notice, setNotice] = useState('')
  const [nextItemKey, setNextItemKey] = useState(2)
  const timelineEnd = useRef<HTMLDivElement>(null)

  async function refreshHome(showLoading = false) {
    if (!supabase) {
      setError('Supabase is not configured. Add the project URL and publishable key to the hosting environment.')
      setLoading(false)
      return
    }
    if (showLoading) setLoading(true)
    const [locationResult, conversationResult, orderResult, settingsResult, feeResult] = await Promise.all([
      supabase.from('pickup_locations')
        .select('id,name,minimum_rider_delivery_fee,maximum_rider_delivery_fee')
        .eq('is_active', true),
      supabase.rpc('get_my_pickup_conversations'),
      supabase.from('orders')
        .select('id,status,total_amount,delivery_fee,delivery_location,created_at,pickup_location_id,accepted_quote_id,delivery_partner_id,order_items(product_name,quantity,unit_price)')
        .or(`customer_id.eq.${session.user.id},delivery_partner_id.eq.${session.user.id}`)
        .not('accepted_quote_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase.rpc('get_my_rider_pickup_settings'),
      supabase.rpc('get_my_rider_pickup_fees'),
    ])
    const failure = locationResult.error ?? conversationResult.error ?? orderResult.error ?? settingsResult.error ?? feeResult.error
    if (failure) {
      setError(`Pickup services could not be loaded: ${failure.message}`)
    } else if (locations.some((location) => !(locationResult.data ?? []).some((row) => row.id === location.id && row.name === location.name))) {
      setError('Pickup locations are not fully configured. Apply the Campus Rider pickup migration in Supabase.')
    } else {
      setError('')
      setPickupLocations(locationResult.data ?? [])
      setConversations(conversationResult.data ?? [])
      setOrders(orderResult.data ?? [])
      const currentSettings = settingsResult.data?.[0]
      if (currentSettings) {
        const storedFees = (feeResult.data ?? {}) as Partial<Record<PickupLocationId, number>>
        const nextSupportedLocations = currentSettings.supported_locations ?? []
        setSettings({ ...currentSettings, pickup_delivery_fees: storedFees })
        setDraftLocations(nextSupportedLocations)
        setDraftFees({
          canteen: storedFees.canteen == null ? '' : String(storedFees.canteen),
          cafeteria: storedFees.cafeteria == null ? '' : String(storedFees.cafeteria),
          gate: storedFees.gate == null ? '' : String(storedFees.gate),
        })
        if (!settingsInitialized) {
          setSettingsInitialized(true)
        }
      }
    }
    setLoading(false)
  }

  const refreshHomeEvent = useEffectEvent(refreshHome)

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

  async function chooseLocation(locationId: PickupLocationId) {
    setSelectedLocation(locationId)
    setRiders([])
    setPage('riders')
    setRidersLoading(true)
    setError('')
    setNotice('')
    if (!supabase) {
      setError('Supabase is not configured. Add the project URL and publishable key to the hosting environment.')
      setRidersLoading(false)
      return
    }
    const { data, error: riderError } = await supabase.rpc('list_available_pickup_riders', { location_id: locationId })
    if (riderError) setError(`Available riders could not be loaded: ${riderError.message}`)
    else setRiders(data ?? [])
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
      setError(feeErrors[0])
      return
    }
    if (online && draftLocations.some((id) => !draftFees[id].trim())) {
      setError('Set a delivery fee for every pickup location you want to serve before going online.')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    const { data, error: saveError } = await supabase.rpc('save_rider_pickup_settings', {
      pickup_locations: draftLocations,
      delivery_fees: deliveryFees,
      online,
    })
    if (saveError) setError(saveError.message)
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
            <div className="pickup-section-heading"><div><span className="section-eyebrow">RIDER WORKSPACE</span><h3>Offer pickup help</h3><p>Choose the pickup points you can deliver from, set a charge for each one, and go online when ready.</p></div><span className={`pickup-status ${settings.is_online ? 'online' : ''}`}><i />{settings.is_online ? 'ONLINE' : 'OFFLINE'}</span></div>
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
                    disabled={busy}
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
              <button type="button" onClick={() => void saveRiderSettings(!settings.is_online)} disabled={busy}>
                {busy ? 'Saving…' : settings.is_online ? 'Stop Accepting Requests' : 'Start Delivering'}
              </button>
              <button className="pickup-secondary-button" type="button" onClick={() => void saveRiderSettings(settings.is_online)} disabled={busy}>Save rider settings</button>
            </div>
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
                  <small className="pickup-payment-note">Campus Rider does not collect or process payment.</small>
                  <div className="pickup-order-bottom"><span>Items + delivery <strong>₹{Number(order.total_amount).toFixed(2)}</strong>{order.delivery_fee !== null && <small> (₹{Number(order.delivery_fee).toFixed(2)} delivery)</small>}</span>
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
            : riders.length === 0 ? <div className="pickup-empty-state"><span><Bike size={23} /></span><h3>No riders are available right now</h3><p>Try again shortly or choose another pickup location.</p></div>
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
    </section>
  )
}
