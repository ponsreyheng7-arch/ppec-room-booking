'use strict';

const TZ = 'Asia/Phnom_Penh';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  user: null, demo: false, page: 'dashboard', calendarDate: todayISO(), calendarView: 'week',
  meta: { rooms: [], surgeryTypes: [], operatingHours: [] }, doctors: [], bookings: [], calendar: [], blockedPeriods: [], payments: [], paymentHistory: [], auditLogs: [], dashboard: null,
  pendingBooking: null, demoDismissed: false, currentPaymentFilters: { status: 'all', unpaid: false, from: '', to: '', paymentFrom: '', paymentTo: '', doctorId: 'all' }
};

function todayISO(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
function dateShift(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + days, 12));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}
function weekStart(dateString) {
  const [y,m,d] = dateString.split('-').map(Number);
  const x = new Date(Date.UTC(y,m-1,d,12));
  const offset = (x.getUTCDay() + 6) % 7;
  return dateShift(dateString, -offset);
}
function fmtDate(date, options = { day: 'numeric', month: 'short', year: undefined }) {
  const d = new Date(`${String(date).slice(0, 10)}T12:00:00+07:00`);
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...options }).format(d);
}
function fmtDateLong(date) { return fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
function fmtTime(value) { return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)); }
function fmtCurrency(value, currency = 'USD') { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0)); }
function fmtNumber(value) { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(Number(value || 0)); }
function initials(name = 'PPEC User') { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join(''); }
function esc(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function statusClass(status) { return String(status || '').toLowerCase().replaceAll('_', '-').replaceAll(' ', '-'); }
function statusLabel(status) { return ({ no_show: 'No-show', 'no-show': 'No-show', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', rescheduled: 'Rescheduled', Pending: 'Pending', 'Partially paid': 'Partially paid', Paid: 'Paid', reversed: 'Reversed' })[status] || status || '—'; }
function badge(status) { return `<span class="status ${statusClass(status)}">${esc(statusLabel(status))}</span>`; }
function isAdmin() { return state.user?.role === 'admin'; }
function isDoctor() { return state.user && state.user.role !== 'admin'; }
function titleCase(value = '') { return String(value).replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()); }

async function api(path, options = {}) {
  const config = { method: options.method || 'GET', credentials: 'same-origin', headers: { ...(options.headers || {}) } };
  if (options.body !== undefined) { config.headers['Content-Type'] = 'application/json'; config.body = JSON.stringify(options.body); }
  const response = await fetch(path, config);
  const contentType = response.headers.get('content-type') || '';
  let result = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 428) showPasswordScreen();
    const message = typeof result === 'object' ? (result.message || result.error || 'Request failed.') : 'Request failed.';
    const error = new Error(message); error.status = response.status; error.data = result; throw error;
  }
  return result;
}

function seedDemo() {
  const plus = (mins, date = new Date()) => new Date(date.getTime() + mins * 60000).toISOString();
  const base = todayISO();
  const demoDoc = [
    { doctor_id: 'doc-1', user_id: 'user-1', doctor_code: 'PPEC-001', full_name: 'Dr. Sopheak Vann', phone: '85512000001', email: 'sopheak@example.test', doctor_type: 'internal', status: 'active', commission_percentage: 18, workplace: 'Phnom Penh Eye Clinic', medical_license_number: 'DEMO-001', payment_method: 'Bank transfer' },
    { doctor_id: 'doc-2', user_id: 'user-2', doctor_code: 'PPEC-002', full_name: 'Dr. Lina Chan', phone: '85512000002', email: 'lina@example.test', doctor_type: 'internal', status: 'active', commission_percentage: 20, workplace: 'Phnom Penh Eye Clinic', medical_license_number: 'DEMO-002', payment_method: 'Bank transfer' },
    { doctor_id: 'doc-3', user_id: 'user-3', doctor_code: 'EXT-014', full_name: 'Dr. Dara Sok', phone: '85512000003', email: 'dara@example.test', doctor_type: 'external', status: 'active', commission_percentage: 25, workplace: 'Sample Partner Hospital', medical_license_number: 'DEMO-003', payment_method: 'Cash' },
    { doctor_id: 'doc-4', user_id: 'user-4', doctor_code: 'EXT-017', full_name: 'Dr. Maly Choun', phone: '85512000004', email: 'maly@example.test', doctor_type: 'external', status: 'active', commission_percentage: 22, workplace: 'Sample Eye Centre', medical_license_number: 'DEMO-004', payment_method: 'Bank transfer' },
    { doctor_id: 'doc-5', user_id: 'user-5', doctor_code: 'PPEC-006', full_name: 'Dr. Vuthy Lim', phone: '85512000005', email: 'vuthy@example.test', doctor_type: 'internal', status: 'active', commission_percentage: 17, workplace: 'Phnom Penh Eye Clinic', medical_license_number: 'DEMO-005', payment_method: 'Bank transfer' }
  ];
  state.demoDoctors = demoDoc;
  state.meta = {
    rooms: [{ id: 'room-a', code: 'A', display_name: 'Bed A — Zeiss' }, { id: 'room-b', code: 'B', display_name: 'Bed B — Leica' }],
    surgeryTypes: [{ id: 'type-pterygium', name: 'Pterygium surgery', default_duration_minutes: 30 }, { id: 'type-cataract', name: 'Cataract surgery', default_duration_minutes: 60 }, { id: 'type-eyelid', name: 'Eyelid surgery', default_duration_minutes: 60 }, { id: 'type-other30', name: 'Other surgery — 30 minutes', default_duration_minutes: 30 }, { id: 'type-other60', name: 'Other surgery — 60 minutes', default_duration_minutes: 60 }],
    operatingHours: []
  };
  state.calendar = [];
  const patients = [
    ['P-24118','Sokunthea Mey','012 000 111'],['P-24119','Rithy Phan','012 000 222'],['P-24120','Sreypov Chea','012 000 333'],['P-24121','Borey Heng','012 000 444'],['P-24122','Narin Kim','012 000 555'],['P-24123','Chenda Oum','012 000 666'],['P-24124','Sokha Keo','012 000 777']
  ];
  const schedule = [
    { day: 0, time: '08:00', bed: 'A', doc: 0, surgery: 1, dur: 60, status: 'confirmed', patient: 0 },
    { day: 0, time: '09:00', bed: 'A', doc: 0, surgery: 0, dur: 30, status: 'confirmed', patient: 1 },
    { day: 0, time: '09:30', bed: 'B', doc: 2, surgery: 1, dur: 60, status: 'confirmed', patient: 2 },
    { day: 0, time: '14:00', bed: 'A', doc: 1, surgery: 2, dur: 60, status: 'confirmed', patient: 3 },
    { day: 0, time: '15:00', bed: 'B', doc: 3, surgery: 0, dur: 30, status: 'confirmed', patient: 4 },
    { day: 1, time: '08:30', bed: 'B', doc: 2, surgery: 1, dur: 60, status: 'confirmed', patient: 5 },
    { day: 1, time: '10:00', bed: 'A', doc: 1, surgery: 0, dur: 30, status: 'confirmed', patient: 6 },
    { day: 2, time: '14:30', bed: 'A', doc: 4, surgery: 1, dur: 60, status: 'confirmed', patient: 2 },
    { day: 3, time: '08:00', bed: 'A', doc: 0, surgery: 0, dur: 30, status: 'confirmed', patient: 4 },
    { day: 4, time: '14:00', bed: 'B', doc: 3, surgery: 2, dur: 60, status: 'confirmed', patient: 1 },
    { day: -1, time: '08:00', bed: 'A', doc: 0, surgery: 1, dur: 60, status: 'completed', patient: 3 },
    { day: -1, time: '14:30', bed: 'B', doc: 2, surgery: 0, dur: 30, status: 'completed', patient: 6 },
    { day: -3, time: '09:00', bed: 'A', doc: 1, surgery: 2, dur: 60, status: 'cancelled', patient: 5 }
  ];
  state.calendar = schedule.map((s, i) => {
    const date = dateShift(base, s.day); const [hh, mm] = s.time.split(':').map(Number);
    const start = new Date(`${date}T${s.time}:00+07:00`); const end = new Date(start.getTime() + s.dur * 60000);
    const patient = patients[s.patient]; const doctor = demoDoc[s.doc]; const type = state.meta.surgeryTypes[s.surgery];
    return { id: `demo-booking-${i+1}`, booking_code: `PPEC-DEMO-${String(i+1).padStart(3,'0')}`, doctor_id: doctor.doctor_id, doctor_code: doctor.doctor_code, doctor_name: doctor.full_name,
      start_at: start.toISOString(), end_at: end.toISOString(), status: s.status, bed_code: s.bed, bed_name: s.bed === 'A' ? 'Bed A — Zeiss' : 'Bed B — Leica', operating_room_id: s.bed === 'A' ? 'room-a' : 'room-b',
      surgery_type: type.name, surgery_type_id: type.id, patient_id: `patient-${s.patient}`, ppec_patient_id: patient[0], patient_name: patient[1], patient_phone: patient[2], external_record_url: '', notes: '' };
  });
  state.demoPayments = [
    { id:'fin-1', booking_id:'demo-booking-11', booking_code:'PPEC-DEMO-011', doctor_id:'doc-1', doctor_code:'PPEC-001', doctor_name:'Dr. Sopheak Vann', patient_reference:'P-24121', surgery_type_name:'Cataract surgery', completed_on:dateShift(base,-1), eligible_surgery_fee:800, commission_percentage_snapshot:18, commission_amount:144, adjustment_amount:0, total_paid:100, outstanding:44, payment_status:'Partially paid', last_payment_date:dateShift(base,-1) },
    { id:'fin-2', booking_id:'demo-booking-12', booking_code:'PPEC-DEMO-012', doctor_id:'doc-3', doctor_code:'EXT-014', doctor_name:'Dr. Dara Sok', patient_reference:'P-24124', surgery_type_name:'Pterygium surgery', completed_on:dateShift(base,-1), eligible_surgery_fee:550, commission_percentage_snapshot:25, commission_amount:137.5, adjustment_amount:0, total_paid:0, outstanding:137.5, payment_status:'Pending', last_payment_date:null },
    { id:'fin-3', booking_id:'demo-booking-old', doctor_id:'doc-2', doctor_code:'PPEC-002', doctor_name:'Dr. Lina Chan', patient_reference:'P-24120', surgery_type_name:'Eyelid surgery', completed_on:dateShift(base,-4), eligible_surgery_fee:950, commission_percentage_snapshot:20, commission_amount:190, adjustment_amount:0, total_paid:190, outstanding:0, payment_status:'Paid', last_payment_date:dateShift(base,-2) }
  ];
  state.demoPaymentHistory = [
    { payment_code:'PAY-DEMO-01', doctor_id:'doc-1', doctor_name:'Dr. Sopheak Vann', doctor_code:'PPEC-001', amount:100, payment_method:'Bank transfer', paid_on:dateShift(base,-1), payment_reference:'DEMO-REF-01', status:'recorded', allocations:[{ bookingCode:'PPEC-DEMO-011', amount:100 }] },
    { payment_code:'PAY-DEMO-02', doctor_id:'doc-2', doctor_name:'Dr. Lina Chan', doctor_code:'PPEC-002', amount:190, payment_method:'Cash', paid_on:dateShift(base,-2), payment_reference:'DEMO-REF-02', status:'recorded', allocations:[{ bookingCode:'PPEC-DEMO-OLD', amount:190 }] }
  ];
  state.demoAuditLogs = [
    { id:1, created_at:plus(-35), actor_name:'PPEC Administrator', action:'booking_created', entity_type:'booking', entity_id:'PPEC-DEMO-001', reason:null },
    { id:2, created_at:plus(-95), actor_name:'PPEC Administrator', action:'surgeon_payment_recorded', entity_type:'payment', entity_id:'PAY-DEMO-01', reason:null },
    { id:3, created_at:plus(-180), actor_name:'PPEC Administrator', action:'doctor_created', entity_type:'doctor', entity_id:'EXT-017', reason:null }
  ];
  state.doctors = demoDoc;
}

function showAuth() {
  $('#auth-screen').classList.remove('hidden'); $('#application').classList.add('hidden'); $('#password-screen').classList.add('hidden');
}
function showPasswordScreen() {
  $('#auth-screen').classList.add('hidden'); $('#application').classList.add('hidden'); $('#password-screen').classList.remove('hidden');
}
function showApplication() {
  $('#auth-screen').classList.add('hidden'); $('#password-screen').classList.add('hidden'); $('#application').classList.remove('hidden');
  $('#side-user-name').textContent = state.user.fullName || state.user.full_name || 'PPEC User';
  $('#side-user-role').textContent = state.user.role === 'admin' ? 'System administrator' : (state.user.doctorType === 'external' || state.user.doctor_type === 'external' ? 'External ophthalmologist' : 'PPEC ophthalmologist');
  $('#top-user-name').textContent = state.user.fullName || state.user.full_name || 'PPEC User';
  $('#top-user-role').textContent = state.user.role === 'admin' ? 'Administrator' : 'Approved surgeon';
  $('#user-avatar').textContent = initials(state.user.fullName || state.user.full_name); $('#top-avatar').textContent = initials(state.user.fullName || state.user.full_name);
  $('#footer-year').textContent = new Date().getFullYear();
  renderNavigation(); updateClock();
  renderPage();
}
function renderNavigation() {
  const adminLinks = [
    { section: 'OVERVIEW', items: [{id:'dashboard',label:'Dashboard',icon:'▦'},{id:'calendar',label:'Operating Room Calendar',icon:'▣'},{id:'bookings',label:'All Bookings',icon:'☷'}] },
    { section: 'PEOPLE & PAYMENTS', items: [{id:'doctors',label:'Surgeon Profiles',icon:'♙'},{id:'payments',label:'Surgeon Payments',icon:'＄'},{id:'reports',label:'Reports & Analytics',icon:'▥'}] },
    { section: 'CONFIGURATION', items: [{id:'surgery-types',label:'Surgery Types',icon:'✳'},{id:'users',label:'User Management',icon:'♧'},{id:'settings',label:'System Settings',icon:'⚙'},{id:'audit',label:'Audit Logs',icon:'◷'}] }
  ];
  const doctorLinks = [
    { section:'MY WORKSPACE',items:[{id:'dashboard',label:'My Dashboard',icon:'▦'},{id:'calendar',label:'Operating Room Calendar',icon:'▣'},{id:'bookings',label:'My Bookings',icon:'☷'}]},
    { section:'MY ACCOUNT',items:[{id:'profile',label:'My Surgeon Profile',icon:'♙'},{id:'payments',label:'My Payments',icon:'＄'}] }
  ];
  const sections = isAdmin() ? adminLinks : doctorLinks;
  $('#main-navigation').innerHTML = sections.map(section => `<div class="nav-section">${section.section}</div>${section.items.map(item=>`<button class="nav-link ${state.page===item.id?'active':''}" data-page="${item.id}"><span class="nav-icon">${item.icon}</span><span>${item.label}</span>${item.id==='payments'&&isAdmin()?'<span class="nav-count" id="nav-unpaid">!</span>':''}</button>`).join('')}`).join('');
  $$('.nav-link').forEach(el => el.addEventListener('click', () => { state.page = el.dataset.page; closeMobileNav(); renderNavigation(); renderPage(); }));
}
function updateClock() {
  const now = new Date();
  $('#current-time').textContent = `${new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hour12:false}).format(now)} · ICT`;
}
function pageHeading(title, subtitle, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${isAdmin()?'ADMINISTRATION':'SURGEON WORKSPACE'}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function demoBanner() {
  if (!state.demo || state.demoDismissed) return '';
  return `<div class="demo-banner"><div><strong>Demo preview mode</strong> — all names and records are fictional. Actions affect this browser session only and are not saved to a database.</div><button data-action="exit-demo">Exit preview ×</button></div>`;
}
function noRows(message, icon='▦') { return `<div class="empty-state"><div class="empty-icon">${icon}</div>${message}</div>`; }
function setToast(message, kind='success') {
  const region = $('#toast-region'); const toast = document.createElement('div'); toast.className = `toast ${kind==='error'?'error':''}`;
  toast.innerHTML = `<span class="toast-mark">${kind==='error'?'!':'✓'}</span><span>${esc(message)}</span>`; region.appendChild(toast);
  setTimeout(()=>toast.remove(), 4400);
}
function showModal({title, subtitle='', body='', footer='', small=false, onReady=null}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop" data-action="backdrop-close"><div class="modal ${small?'small':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle?`<p>${esc(subtitle)}</p>`:''}</div><button type="button" class="icon-button" data-action="close-modal" aria-label="Close dialog">×</button></div><div class="modal-body">${body}</div>${footer?`<div class="modal-foot">${footer}</div>`:''}</div></div>`;
  root.querySelector('[data-action="close-modal"]').addEventListener('click', closeModal);
  root.querySelector('.modal-backdrop').addEventListener('click', e => { if (e.target.dataset.action === 'backdrop-close') closeModal(); });
  if (onReady) onReady(root);
}
function closeModal() { $('#modal-root').innerHTML = ''; state.pendingBooking = null; }
function attachGlobalActions(root = document) {
  $$('[data-action]', root).forEach(el => {
    if (el.dataset.bound) return; el.dataset.bound = '1';
    el.addEventListener('click', async e => {
      const action = el.dataset.action;
      if (action === 'exit-demo') { state.demo = false; state.user = null; showAuth(); return; }
      if (action === 'close-modal') { closeModal(); return; }
      if (action === 'book') { openBookingModal(); return; }
      if (action === 'view-calendar') { state.page = 'calendar'; renderNavigation(); renderPage(); return; }
      if (action === 'view-bookings') { state.page = 'bookings'; renderNavigation(); renderPage(); return; }
      if (action === 'create-doctor') { openDoctorModal(); return; }
      if (action === 'record-payment') { openPaymentModal(el.dataset.id || null); return; }
      if (action === 'export-bookings') { downloadCsv('bookings'); return; }
      if (action === 'export-payments') { downloadCsv('payments'); return; }
      if (action === 'export-surgeons') { downloadCsv('surgeons'); return; }
      if (action === 'add-surgery-type') { openSurgeryTypeModal(); return; }
      if (action === 'open-booking') { openBookingDetail(el.dataset.id); return; }
      if (action === 'doctor-status') { updateDoctorStatus(el.dataset.id, el.dataset.status); return; }
      if (action === 'reset-password') { openResetPasswordModal(el.dataset.id); return; }
      if (action === 'edit-surgery-type') { openSurgeryTypeModal(el.dataset.id); return; }
      if (action === 'mark-status') { updateBookingStatus(el.dataset.id, el.dataset.status); return; }
      if (action === 'cancel-booking') { cancelBooking(el.dataset.id); return; }
      if (action === 'reschedule-booking') { const booking = findBooking(el.dataset.id); closeModal(); openBookingModal(booking); return; }
      if (action === 'profile-detail') { openDoctorDetail(el.dataset.id); return; }
      if (action === 'edit-doctor') { openDoctorEditModal(el.dataset.id); return; }
      if (action === 'remove-blocked-period') { deactivateBlockedPeriod(el.dataset.id); return; }
      if (action === 'record-financial') { openFinancialModal(el.dataset.id); return; }
      if (action === 'adjust-financial') { openFinancialAdjustmentModal(el.dataset.id); return; }
      if (action === 'reverse-payment') { openReversePaymentModal(el.dataset.id); return; }
      if (action === 'view-report') { state.page='reports'; renderNavigation(); renderPage(); return; }
    });
  });
}

async function renderPage() {
  const content = $('#page-content');
  content.innerHTML = `${demoBanner()}<div class="empty-state">Loading workspace…</div>`;
  try {
    let html = '';
    switch (state.page) {
      case 'dashboard': html = await renderDashboard(); break;
      case 'calendar': html = await renderCalendar(); break;
      case 'bookings': html = await renderBookings(); break;
      case 'doctors': html = await renderDoctors(); break;
      case 'profile': html = await renderProfile(); break;
      case 'payments': html = await renderPayments(); break;
      case 'reports': html = await renderReports(); break;
      case 'surgery-types': html = await renderSurgeryTypes(); break;
      case 'users': html = await renderUsers(); break;
      case 'settings': html = await renderSettings(); break;
      case 'audit': html = await renderAudit(); break;
      default: html = await renderDashboard(); state.page = 'dashboard';
    }
    content.innerHTML = `${demoBanner()}${html}`;
    $('#current-page-label').textContent = ({dashboard:'Dashboard',calendar:'Operating Room Calendar',bookings:isAdmin()?'All Bookings':'My Bookings',doctors:'Surgeon Profiles',profile:'My Surgeon Profile',payments:isAdmin()?'Surgeon Payments':'My Payments',reports:'Reports & Analytics','surgery-types':'Surgery Types',users:'User Management',settings:'System Settings',audit:'Audit Logs'})[state.page] || 'Dashboard';
    attachGlobalActions(content);
    wirePageControls();
  } catch (error) {
    content.innerHTML = `${demoBanner()}<div class="panel"><div class="empty-state"><div class="empty-icon">!</div><strong>Couldn't load this page</strong><br>${esc(error.message)}<p><button class="button secondary" id="retry-page">Retry</button></p></div></div>`;
    $('#retry-page')?.addEventListener('click', renderPage);
  }
}

async function loadDashboard() {
  if (state.demo) {
    const base = todayISO(); const todayBookings = state.calendar.filter(b => b.start_at.slice(0,10) === base && !['cancelled','rescheduled'].includes(b.status));
    const bookedHours = todayBookings.reduce((n,b)=>n+(new Date(b.end_at)-new Date(b.start_at))/3600000,0);
    const completed = state.calendar.filter(b=>b.status==='completed');
    return {date:base,counts:{confirmed_today:todayBookings.filter(b=>b.status==='confirmed').length,cancelled_today:state.calendar.filter(b=>b.start_at.slice(0,10)===base&&b.status==='cancelled').length,completed_today:todayBookings.filter(b=>b.status==='completed').length,no_show_today:0},usage:[{bed_code:'A',hours:todayBookings.filter(b=>b.bed_code==='A').reduce((n,b)=>n+(new Date(b.end_at)-new Date(b.start_at))/3600000,0)},{bed_code:'B',hours:todayBookings.filter(b=>b.bed_code==='B').reduce((n,b)=>n+(new Date(b.end_at)-new Date(b.start_at))/3600000,0)}],bookedHours,capacityHours:12,remainingHours:Math.max(0,12-bookedHours),utilizationPct:Math.round(bookedHours/12*100),upcoming:todayBookings.filter(b=>b.status==='confirmed').sort((a,b)=>a.start_at.localeCompare(b.start_at)),surgeryTypes:[],finances:{revenue:state.demoPayments.reduce((n,p)=>n+p.eligible_surgery_fee,0),commission:state.demoPayments.reduce((n,p)=>n+p.commission_amount,0),paid:290},trends:[],completedCount:completed.length,commissionEarned:state.demoPayments.reduce((n,p)=>n+p.commission_amount,0),amountPaid:290,outstanding:state.demoPayments.reduce((n,p)=>n+p.outstanding,0)};
  }
  return await api(`/api/dashboard?date=${todayISO()}`);
}
async function getMeta() { if (state.demo) return state.meta; if (!state.meta.rooms.length) state.meta = await api('/api/meta'); return state.meta; }
async function getDoctors() { if (state.demo) return state.demoDoctors; if (!isAdmin()) return []; const response = await api('/api/doctors'); state.doctors = response.doctors; return response.doctors; }
async function loadBookings(from, to) {
  if (state.demo) return state.calendar.filter(b => b.start_at.slice(0,10)<=to && b.end_at.slice(0,10)>=from).map(b => ({...b,isMine:b.doctor_id===state.user.doctorId}));
  if (from && to && state.page === 'calendar') {
    const r = await api(`/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`); state.rooms = r.rooms; state.blockedPeriods = r.blockedPeriods || []; return r.bookings;
  }
  const query = from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';
  const r = await api(`/api/bookings${query}`); return r.bookings;
}

async function renderDashboard() {
  const data = await loadDashboard(); state.dashboard = data;
  const today = todayISO();
  if (!isAdmin()) {
    const upcoming = (data.upcoming || []).slice(0,5);
    const items = upcoming.map(b => `<div class="schedule-item"><div class="schedule-time"><strong>${fmtTime(b.start_at)}</strong><small>${fmtDate(b.start_at,{day:'numeric',month:'short'})}</small></div><div class="schedule-marker"></div><div class="schedule-info"><strong>${esc(b.surgery_type)}</strong><p>${esc(b.patient_name || 'Patient')} · ${esc(b.bed_code ? `Bed ${b.bed_code}` : '')}</p></div><div class="schedule-meta">${badge(b.status)}</div></div>`).join('');
    const outstanding = Number(data.outstanding || 0);
    return `${pageHeading(`Good ${new Date().getHours()<12?'morning':new Date().getHours()<17?'afternoon':'evening'}, ${esc((state.user.fullName||state.user.full_name||'Doctor').split(' ').slice(-1)[0])}`, 'Here is your private operating room schedule and surgeon account overview.', `<button class="button primary" data-action="book">＋ New booking</button>`)}
      <div class="kpi-grid grid"><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">My upcoming surgeries</span><span class="kpi-icon">▣</span></div><div class="kpi-value">${data.upcoming?.length || 0}</div><div class="kpi-foot">Confirmed future bookings</div></div><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Completed surgeries</span><span class="kpi-icon">✓</span></div><div class="kpi-value">${data.completedCount || 0}</div><div class="kpi-foot">All-time recorded completions</div></div><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Commission earned</span><span class="kpi-icon">＄</span></div><div class="kpi-value">${fmtCurrency(data.commissionEarned)}</div><div class="kpi-foot">Recorded completed surgeries</div></div><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Outstanding balance</span><span class="kpi-icon">◷</span></div><div class="kpi-value">${fmtCurrency(outstanding)}</div><div class="kpi-foot">Based on recorded payments only</div></div></div>
      <div class="dashboard-grid grid"><section class="panel"><div class="panel-header"><div><div class="panel-title">My upcoming surgeries</div><div class="panel-subtitle">Your next confirmed operating room bookings</div></div><button class="plain-link" data-action="view-bookings">View all →</button></div>${items || noRows('No upcoming surgeries have been booked yet.','▣')}<div class="panel-body"><button class="button secondary full" data-action="view-calendar">View operating room availability</button></div></section>
      <section class="panel utilization-panel"><div class="utilization-head"><div><h3>Booking at a glance</h3><p>Use the shared calendar to find a free bed.</p></div><span class="kpi-icon">◷</span></div><div class="bed-utilization"><div class="bed-util-row"><span>Bed A · Zeiss</span><strong>Available slots</strong></div><div class="mini-track"><span style="width:60%"></span></div><div class="bed-util-row"><span>Bed B · Leica</span><strong>Available slots</strong></div><div class="mini-track"><span style="width:76%"></span></div></div><div class="util-footer"><span>✦</span><span>Book at least <strong>48 hours in advance</strong>. Surgery must fit in a morning or afternoon session.</span></div></section></div>`;
  }
  const usage = data.usage || [];
  const bookedPercent = Number(data.utilizationPct || 0);
  const bookings = (data.upcoming || []).slice(0,6);
  const scheduleItems = bookings.map(b => `<div class="schedule-item"><div class="schedule-time"><strong>${fmtTime(b.start_at)}</strong><small>${fmtTime(b.end_at)} end</small></div><div class="schedule-marker"></div><div class="schedule-info"><strong>${esc(b.patient_name)}</strong><p>${esc(b.surgery_type)} · ${esc(b.doctor_name)}</p></div><div class="schedule-meta"><span class="bed-tag">Bed ${esc(b.bed_code)}</span><small>${badge(b.status)}</small></div></div>`).join('');
  const usageBars = usage.map(r=>`<div class="bed-util-row"><span>Bed ${esc(r.bed_code)} · ${r.bed_code==='A'?'Zeiss':'Leica'}</span><strong>${fmtNumber(r.hours)}h / 6h</strong></div><div class="mini-track"><span style="width:${Math.min(100,Number(r.hours)/6*100)}%"></span></div>`).join('');
  const finances = data.finances || {};
  const totalOutstanding = Number(finances.commission || 0) - Number(finances.paid || 0);
  return `${pageHeading('Operating room overview', `${fmtDateLong(today)} · Your command centre for bookings, beds and surgeon payments.`, `<button class="button secondary" data-action="view-calendar">View calendar</button><button class="button primary" data-action="book">＋ New booking</button>`)}
    <div class="kpi-grid grid"><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Confirmed today</span><span class="kpi-icon">▣</span></div><div class="kpi-value">${data.counts?.confirmed_today ?? 0}</div><div class="kpi-foot"><span class="positive">${data.counts?.completed_today ?? 0} completed</span> today</div></div><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Bed-hours booked</span><span class="kpi-icon">◷</span></div><div class="kpi-value">${fmtNumber(data.bookedHours)}<span style="font-size:15px;color:#91a29c;font-weight:600"> / ${data.capacityHours}h</span></div><div class="kpi-foot">Across both operating beds</div></div><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Bed utilization</span><span class="kpi-icon">◌</span></div><div class="kpi-value">${bookedPercent}%</div><div class="kpi-foot">Scheduled time used today</div></div><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Outstanding surgeon payments</span><span class="kpi-icon">＄</span></div><div class="kpi-value">${fmtCurrency(Math.max(0,totalOutstanding))}</div><div class="kpi-foot">Based on recorded surgery fees</div></div></div>
    <div class="dashboard-grid grid"><section class="panel"><div class="panel-header"><div><div class="panel-title">Today's operating schedule</div><div class="panel-subtitle">Confirmed surgeries · Patient and surgeon details are admin-only</div></div><button class="plain-link" data-action="view-calendar">Full calendar →</button></div>${scheduleItems || noRows('No confirmed surgeries are scheduled for this day.','▣')}<div class="panel-body"><button class="button secondary full" data-action="view-bookings">Manage all bookings</button></div></section>
    <section class="panel utilization-panel"><div class="utilization-head"><div><h3>Bed utilization</h3><p>${fmtDateLong(today)}</p></div><div class="utilization-number">${bookedPercent}%</div></div><div class="progress-track"><div class="progress-fill" style="width:${bookedPercent}%"></div></div><div class="progress-meta"><span>${fmtNumber(data.bookedHours)} hours booked</span><span>${fmtNumber(data.remainingHours)} hours free</span></div><div class="bed-utilization">${usageBars || '<p class="muted">No bed activity recorded.</p>'}</div><div class="util-footer"><span>✦</span><span>Operating capacity is <strong>${data.capacityHours} bed-hours</strong> per working day.</span></div></section></div>
    <div class="section-top"><h3>Operations shortcuts</h3><span class="muted">Common tasks</span></div><div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:12px"><button class="panel" style="text-align:left;padding:17px;border:1px solid var(--line);color:var(--ink)" data-action="book"><span class="kpi-icon">＋</span><div class="table-primary" style="margin-top:12px">Create a booking</div><div class="table-secondary">Reserve an available bed</div></button><button class="panel" style="text-align:left;padding:17px;border:1px solid var(--line);color:var(--ink)" data-action="create-doctor"><span class="kpi-icon">♙</span><div class="table-primary" style="margin-top:12px">Add a surgeon</div><div class="table-secondary">Create approved doctor access</div></button><button class="panel" style="text-align:left;padding:17px;border:1px solid var(--line);color:var(--ink)" data-action="record-payment"><span class="kpi-icon">＄</span><div class="table-primary" style="margin-top:12px">Record a payment</div><div class="table-secondary">Allocate surgeon commissions</div></button></div>`;
}

function getCalendarDates() {
  if (state.calendarView === 'day') return [state.calendarDate];
  if (state.calendarView === 'month') {
    const [y,m] = state.calendarDate.split('-').map(Number); const first = `${y}-${String(m).padStart(2,'0')}-01`;
    const start = weekStart(first); const lastDate = new Date(Date.UTC(y,m,0,12)).getUTCDate();
    const end = dateShift(first, lastDate - 1); const total = Math.round((new Date(`${end}T12:00:00Z`)-new Date(`${start}T12:00:00Z`))/86400000)+1;
    return Array.from({length:total},(_,i)=>dateShift(start,i));
  }
  const start = weekStart(state.calendarDate); return Array.from({length:7},(_,i)=>dateShift(start,i));
}
async function renderCalendar() {
  const dates = getCalendarDates(); const from = dates[0], to = dates[dates.length-1];
  const [bookings, meta] = await Promise.all([loadBookings(from,to),getMeta()]);
  state.calendar = state.demo ? state.calendar : state.calendar;
  state.currentCalendarBookings = bookings;
  const titleDate = state.calendarView === 'day' ? fmtDateLong(state.calendarDate) : state.calendarView === 'month' ? fmtDate(state.calendarDate,{month:'long',year:'numeric'}) : `${fmtDate(from,{day:'numeric',month:'short'})} – ${fmtDate(to,{day:'numeric',month:'short',year:'numeric'})}`;
  const dateCells = dates.map(date => {
    const db = bookings.filter(b=>b.start_at.slice(0,10)===date&& !['cancelled','rescheduled'].includes(b.status));
    return `<div class="calendar-day ${date===todayISO()?'today':''}"><div class="calendar-day-head"><span>${fmtDate(date,{weekday:'short'})}</span><strong>${fmtDate(date,{day:'numeric',month:state.calendarView==='month'?'short':undefined})}</strong></div><div class="calendar-day-body">${db.length?db.sort((a,b)=>a.start_at.localeCompare(b.start_at)).map(b=>`<div class="calendar-booking ${b.isMine===false&&!isAdmin()?'generic':''}" ${b.isMine===false&&!isAdmin()?'':'data-action="open-booking" data-id="'+esc(b.id)+'"'}><strong>${b.isMine===false&&!isAdmin()?'Booked':esc(b.surgery_type || b.booking_code)}</strong><small>${fmtTime(b.start_at)}–${fmtTime(b.end_at)}<br>${esc(b.bed_name || `Bed ${b.bed_code}`)}${(isAdmin()||b.isMine!==false)?` · ${esc(b.patient_name || b.doctor_name || '')}`:''}</small></div>`).join(''):`<div class="calendar-empty">No bookings</div>`}</div></div>`;
  }).join('');
  const selected = bookings.filter(b=>b.start_at.slice(0,10)===state.calendarDate);
  const slots = getTimeSlotsForDate(state.calendarDate);
  const roomRows = (meta.rooms||[]).map(room=>{
    const events=selected.filter(b=>(b.operating_room_id===room.id || b.bed_code===room.code)&&!['cancelled','rescheduled'].includes(b.status));
    const slotHtml=slots.map(time=>{
      const start=new Date(`${state.calendarDate}T${time}:00+07:00`),end=new Date(start.getTime()+1800000);const busy=events.some(b=>new Date(b.start_at)<end&&new Date(b.end_at)>start);
      const blocked=(state.blockedPeriods||[]).some(bp=>(!bp.operating_room_id||bp.operating_room_id===room.id)&&new Date(bp.starts_at)<end&&new Date(bp.ends_at)>start);const label=busy?'Booked':blocked?'Unavailable':'Available';
      return `<span class="time-slot ${busy?'busy':blocked?'closed':'available'}" title="${time} · ${label}">${time}</span>`;
    }).join('');
    return `<div class="room-row"><div class="room-name"><strong>${esc(room.display_name)}</strong><small>${events.length} scheduled blocks</small></div><div class="room-timeline">${slotHtml||'<span class="muted">No operating session configured</span>'}</div></div>`;
  }).join('');
  return `${pageHeading('Operating room calendar','Review both operating beds and reserve a free slot without seeing another surgeon’s private booking details.',`<button class="button primary" data-action="book">＋ New booking</button>`)}
    <section class="panel"><div class="panel-header"><div><div class="panel-title">Surgery schedule</div><div class="panel-subtitle">${esc(titleDate)} · Cambodia local time (ICT)</div></div><div class="panel-actions"><button class="button secondary small" id="calendar-prev">←</button><button class="button secondary small" id="calendar-today">Today</button><button class="button secondary small" id="calendar-next">→</button></div></div>
    <div class="panel-header" style="border-top:1px solid var(--line);padding-top:13px;padding-bottom:13px"><div class="calendar-legend"><span><i class="legend-dot"></i> Available</span><span><i class="legend-dot booked"></i> Booked</span><span><i class="legend-dot closed"></i> Break / closed</span></div><div class="segmented"><button class="segment ${state.calendarView==='day'?'active':''}" data-calendar-view="day">Day</button><button class="segment ${state.calendarView==='week'?'active':''}" data-calendar-view="week">Week</button><button class="segment ${state.calendarView==='month'?'active':''}" data-calendar-view="month">Month</button></div></div>
    <div class="calendar-day-grid">${dateCells}</div><div class="calendar-room-section"><div class="section-top" style="margin-top:0"><h3>Bed availability</h3><span class="muted">${fmtDateLong(state.calendarDate)}</span></div>${roomRows}<p class="footnote" style="margin-top:13px">The grid is a quick availability guide. Availability is checked again on the server before a booking is saved. A full operation must fit within 08:00–11:00 or 14:00–17:00.</p></div></section>`;
}

async function renderBookings() {
  const start = dateShift(todayISO(), -30), end = dateShift(todayISO(), 120);
  const bookings = await loadBookings(start,end); state.currentBookings = bookings;
  const rows = bookings.filter(b=>b.status!=='rescheduled').map(b=>`<tr><td><div class="table-primary">${esc(b.booking_code)}</div><div class="table-secondary">${fmtDate(b.start_at,{day:'numeric',month:'short',year:'numeric'})}</div></td><td><div class="table-primary">${esc(b.surgery_type)}</div><div class="table-secondary">${fmtTime(b.start_at)}–${fmtTime(b.end_at)}</div></td><td><span class="bed-tag">Bed ${esc(b.bed_code)}</span></td><td><div class="table-primary">${esc(b.patient_name || (b.isMine===false?'Private booking':'—'))}</div><div class="table-secondary">${esc((isAdmin()||b.isMine!==false)?(b.ppec_patient_id || 'No PPEC ID'):'')}</div></td>${isAdmin()?`<td><div class="table-primary">${esc(b.doctor_name)}</div><div class="table-secondary">${esc(b.doctor_code)}</div></td>`:''}<td>${badge(b.status)}</td><td><div class="table-actions"><button class="button secondary small" data-action="open-booking" data-id="${esc(b.id)}">Details</button></div></td></tr>`).join('');
  return `${pageHeading(isAdmin()?'All operating room bookings':'My bookings','Search historical and upcoming bookings, review their status, or open a booking to manage it.',`<button class="button secondary" data-action="export-bookings">↓ Export CSV</button><button class="button primary" data-action="book">＋ New booking</button>`)}
    <div class="toolbar"><div class="search-field"><span>⌕</span><input id="booking-search" placeholder="Search booking ID, patient, surgery…" aria-label="Search bookings"></div><select id="booking-status-filter" class="filter-select"><option value="all">All statuses</option><option value="confirmed">Confirmed</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="no_show">No-show</option><option value="rescheduled">Rescheduled</option></select><input id="booking-from" class="filter-select" type="date" value="${start}" aria-label="From date"><input id="booking-to" class="filter-select" type="date" value="${end}" aria-label="To date"></div>
    <section class="panel"><div class="panel-header"><div><div class="panel-title">${bookings.length} booking records</div><div class="panel-subtitle">${isAdmin()?'All surgeons and patients · Full details visible to administrators':'Only your own patient and booking details are shown'}</div></div></div><div class="table-wrap"><table><thead><tr><th>Booking ID</th><th>Surgery / time</th><th>Bed</th><th>Patient</th>${isAdmin()?'<th>Surgeon</th>':''}<th>Status</th><th></th></tr></thead><tbody id="booking-table-body">${rows || `<tr><td colspan="${isAdmin()?7:6}">${noRows('No booking records found.','▣')}</td></tr>`}</tbody></table></div></section>`;
}

async function renderDoctors() {
  const doctors = await getDoctors(); state.doctors=doctors;
  const rows = doctors.map(d=>`<tr><td><div style="display:flex;align-items:center;gap:10px"><div class="avatar">${initials(d.full_name)}</div><div><div class="table-primary">${esc(d.full_name)}</div><div class="table-secondary">${esc(d.doctor_code)}</div></div></div></td><td><div class="table-primary">${esc(d.phone)}</div><div class="table-secondary">${esc(d.email||'No email')}</div></td><td><span class="status ${d.doctor_type==='external'?'completed':'confirmed'}">${esc(titleCase(d.doctor_type))}</span></td><td><div class="table-primary">${esc(d.workplace||'—')}</div><div class="table-secondary">${esc(d.medical_license_number||'License not recorded')}</div></td><td><div class="table-primary">${Number(d.commission_percentage||0).toFixed(2)}%</div><div class="table-secondary">${esc(d.payment_method||'No method')}</div></td><td>${badge(d.status)}</td><td><div class="table-actions"><button class="button secondary small" data-action="profile-detail" data-id="${esc(d.doctor_id||d.id)}">View</button><button class="button secondary small" data-action="edit-doctor" data-id="${esc(d.doctor_id||d.id)}">Edit</button><button class="button secondary small" data-action="reset-password" data-id="${esc(d.doctor_id||d.id)}">Reset password</button></div></td></tr>`).join('');
  return `${pageHeading('Surgeon profiles','Manage approved internal and external ophthalmologists, their professional details and commission terms.',`<button class="button secondary" data-action="export-surgeons">↓ Export CSV</button><button class="button primary" data-action="create-doctor">＋ Add surgeon</button>`)}
    <div class="stats-row"><div class="stat-tile"><span>Total surgeon profiles</span><strong>${doctors.length}</strong></div><div class="stat-tile"><span>Internal doctors</span><strong>${doctors.filter(d=>(d.doctor_type||d.doctorType)==='internal').length}</strong></div><div class="stat-tile"><span>External doctors</span><strong>${doctors.filter(d=>(d.doctor_type||d.doctorType)==='external').length}</strong></div></div>
    <div class="toolbar"><div class="search-field"><span>⌕</span><input id="doctor-search" placeholder="Search name, Doctor ID, phone…" aria-label="Search surgeons"></div><select id="doctor-type-filter" class="filter-select"><option value="all">All categories</option><option value="internal">Internal</option><option value="external">External</option></select><select id="doctor-status-filter" class="filter-select"><option value="all">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="inactive">Inactive</option></select></div>
    <section class="panel"><div class="panel-header"><div><div class="panel-title">Approved surgeons</div><div class="panel-subtitle">Commission terms are restricted to administrators and the relevant surgeon.</div></div></div><div class="table-wrap"><table><thead><tr><th>Surgeon</th><th>Contact</th><th>Category</th><th>Workplace / license</th><th>Commission</th><th>Access status</th><th>Actions</th></tr></thead><tbody id="doctor-table-body">${rows || `<tr><td colspan="7">${noRows('No surgeon profiles have been created.','♙')}</td></tr>`}</tbody></table></div></section>`;
}

async function renderProfile() {
  if (state.demo) {
    const d = state.demoDoctors.find(x=>x.doctor_id===state.user.doctorId) || state.demoDoctors[0];
    const payments=state.demoPayments.filter(x=>x.doctor_id===d.doctor_id); const earned=payments.reduce((n,x)=>n+x.commission_amount,0),paid=payments.reduce((n,x)=>n+x.total_paid,0);
    return `${pageHeading('My surgeon profile','Review your approved professional details and agreed commission terms. Changes to restricted fields must be requested from the administrator.')}
      <div class="panel"><div class="profile-card"><div class="profile-large-avatar">${initials(d.full_name)}</div><div class="profile-main"><h3>${esc(d.full_name)}</h3><p>${esc(d.doctor_code)} · ${titleCase(d.doctor_type)} ophthalmologist<br>${esc(d.workplace)}</p></div>${badge(d.status)}</div><div class="profile-fields"><div class="profile-field"><span>Commission rate</span><strong>${d.commission_percentage}%</strong></div><div class="profile-field"><span>Completed surgeries</span><strong>${state.calendar.filter(b=>b.doctor_id===d.doctor_id&&b.status==='completed').length}</strong></div><div class="profile-field"><span>Outstanding balance</span><strong>${fmtCurrency(earned-paid)}</strong></div></div><div style="padding:5px 20px 22px"><div class="key-value"><span>Registered phone</span><strong>${esc(d.phone)}</strong></div><div class="key-value"><span>Email address</span><strong>${esc(d.email||'Not provided')}</strong></div><div class="key-value"><span>Medical license</span><strong>${esc(d.medical_license_number||'Not recorded')}</strong></div><div class="key-value"><span>Licensing authority</span><strong>—</strong></div><div class="key-value"><span>Payment method</span><strong>${esc(d.payment_method||'Not set')}</strong></div></div></div>`;
  }
  const r=await api('/api/doctors/me'); const d=r.doctor;
  return `${pageHeading('My surgeon profile','Review your approved professional details and agreed commission terms. Ask the administrator to update restricted fields.')}
    <div class="panel"><div class="profile-card"><div class="profile-large-avatar">${initials(d.full_name)}</div><div class="profile-main"><h3>${esc(d.full_name)}</h3><p>${esc(d.doctor_code)} · ${titleCase(d.doctor_type)} ophthalmologist<br>${esc(d.workplace||'Workplace not set')}</p></div>${badge(d.account_status)}</div><div class="profile-fields"><div class="profile-field"><span>Commission rate</span><strong>${Number(d.commission_percentage||0).toFixed(2)}%</strong></div><div class="profile-field"><span>Completed surgeries</span><strong>${d.completed_surgeries}</strong></div><div class="profile-field"><span>Outstanding balance</span><strong>${fmtCurrency(d.outstanding_balance)}</strong></div></div><div style="padding:5px 20px 22px"><div class="key-value"><span>Registered phone</span><strong>${esc(d.phone)}</strong></div><div class="key-value"><span>Email address</span><strong>${esc(d.email||'Not provided')}</strong></div><div class="key-value"><span>Medical license</span><strong>${esc(d.medical_license_number||'Not recorded')}</strong></div><div class="key-value"><span>Licensing authority</span><strong>${esc(d.licensing_authority||'Not recorded')}</strong></div><div class="key-value"><span>Payment method</span><strong>${esc(d.payment_method||'Not set')}</strong></div></div></div>`;
}

async function loadPayments(params = {}) {
  if (state.demo) {
    let items = [...state.demoPayments];
    if (!isAdmin()) items=items.filter(p=>p.doctor_id===state.user.doctorId);
    if (params.doctorId && params.doctorId!=='all') items=items.filter(p=>p.doctor_id===params.doctorId);
    if (params.status && params.status!=='all') items=items.filter(p=>p.payment_status===params.status);
    if (params.unpaid) items=items.filter(p=>Number(p.outstanding)>0);
    if (params.from) items=items.filter(p=>String(p.completed_on)>=params.from);
    if (params.to) items=items.filter(p=>String(p.completed_on)<=params.to);
    if (params.paymentFrom) items=items.filter(p=>p.last_payment_date && String(p.last_payment_date)>=params.paymentFrom);
    if (params.paymentTo) items=items.filter(p=>p.last_payment_date && String(p.last_payment_date)<=params.paymentTo);
    return {items,summary:items.reduce((a,x)=>{a.completedSurgeries++;a.eligibleRevenue+=Number(x.eligible_surgery_fee);a.commissionEarned+=Number(x.commission_amount)+Number(x.adjustment_amount);a.totalPaid+=Number(x.total_paid);a.outstanding+=Number(x.outstanding);return a;},{completedSurgeries:0,eligibleRevenue:0,commissionEarned:0,totalPaid:0,outstanding:0})};
  }
  const query = new URLSearchParams(); Object.entries(params).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!==''&&v!==false&&v!=='all')query.set(k,v===true?'true':v)});
  return await api(`/api/surgeon-payments${query.size?'?'+query.toString():''}`);
}
async function renderPayments() {
  const filters = { ...state.currentPaymentFilters };
  const response = await loadPayments(filters); state.payments=response.items;
  const historyParams={};if(filters.paymentFrom)historyParams.from=filters.paymentFrom;if(filters.paymentTo)historyParams.to=filters.paymentTo;if(isAdmin()&&filters.doctorId&&filters.doctorId!=='all')historyParams.doctorId=filters.doctorId;
  const history = state.demo ? state.demoPaymentHistory.filter(p=>(!historyParams.from||p.paid_on>=historyParams.from)&&(!historyParams.to||p.paid_on<=historyParams.to)&&(!historyParams.doctorId||p.doctor_id===historyParams.doctorId)) : (await api(`/api/payments/history${Object.keys(historyParams).length?'?'+new URLSearchParams(historyParams):''}`)).payments;
  state.paymentHistory=history;
  const s=response.summary||{};
  const rows = response.items.map(p=>`<tr><td><div class="table-primary">${esc(p.booking_code)}</div><div class="table-secondary">${fmtDate(p.completed_on,{day:'numeric',month:'short',year:'numeric'})}</div></td>${isAdmin()?`<td><div class="table-primary">${esc(p.doctor_name)}</div><div class="table-secondary">${esc(p.doctor_code)}</div></td>`:''}<td><div class="table-primary">${esc(p.surgery_type_name)}</div><div class="table-secondary">Eligible fee ${fmtCurrency(p.eligible_surgery_fee)}</div></td><td><div class="table-primary">${Number(p.commission_percentage_snapshot).toFixed(2)}%</div><div class="table-secondary">Earned ${fmtCurrency(Number(p.commission_amount)+Number(p.adjustment_amount||0))}</div></td><td>${fmtCurrency(p.total_paid)}</td><td><div class="table-primary ${Number(p.outstanding)>0?'':'muted'}">${fmtCurrency(p.outstanding)}</div><div class="table-secondary">${p.last_payment_date?`Last paid ${fmtDate(p.last_payment_date,{day:'numeric',month:'short'})}`:'No payment recorded'}</div></td><td>${badge(p.payment_status)}</td>${isAdmin()?`<td><div class="table-actions">${Number(p.outstanding)>0?`<button class="button secondary small" data-action="record-payment" data-id="${esc(p.id)}">Pay</button>`:''}<button class="button secondary small" data-action="adjust-financial" data-id="${esc(p.id)}">Adjust</button></div></td>`:''}</tr>`).join('');
  const historyRows=history.map(p=>`<tr><td><div class="table-primary">${esc(p.payment_code)}</div><div class="table-secondary">${fmtDate(p.paid_on,{day:'numeric',month:'short',year:'numeric'})}</div></td>${isAdmin()?`<td><div class="table-primary">${esc(p.doctor_name)}</div><div class="table-secondary">${esc(p.doctor_code)}</div></td>`:''}<td>${fmtCurrency(p.amount)}</td><td>${esc(p.payment_method)}</td><td>${esc(p.payment_reference||'—')}</td><td>${badge(p.status==='reversed'?'reversed':'Paid')}</td>${isAdmin()?`<td>${p.status==='recorded'?`<button class="button secondary small" data-action="reverse-payment" data-id="${esc(p.id)}">Reverse</button>`:''}</td>`:''}</tr>`).join('');
  const paymentActions = isAdmin() ? '<button class="button secondary" data-action="export-payments">↓ Export CSV</button><button class="button primary" data-action="record-payment">＋ Record payment</button>' : '';
  return `${pageHeading(isAdmin()?'Surgeon payments':'My surgeon payments','Track eligible surgery fees, agreed commission, payment allocations and remaining balances.',paymentActions)}
    <div class="kpi-grid grid"><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Completed surgeries</span><span class="kpi-icon">✓</span></div><div class="kpi-value">${s.completedSurgeries||0}</div><div class="kpi-foot">With a recorded financial entry</div></div><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Eligible surgery revenue</span><span class="kpi-icon">＄</span></div><div class="kpi-value">${fmtCurrency(s.eligibleRevenue)}</div><div class="kpi-foot">Recorded eligible fees</div></div><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Commission earned</span><span class="kpi-icon">◌</span></div><div class="kpi-value">${fmtCurrency(s.commissionEarned)}</div><div class="kpi-foot">Uses each surgery's agreed rate</div></div><div class="kpi-card"><div class="kpi-top"><span class="kpi-label">Outstanding balance</span><span class="kpi-icon">◷</span></div><div class="kpi-value">${fmtCurrency(s.outstanding)}</div><div class="kpi-foot">Recorded earned less recorded payments</div></div></div>
    <div class="toolbar"><div class="search-field"><span>⌕</span><input id="payment-search" placeholder="Search Booking ID, surgery or surgeon…" aria-label="Search payments"></div>${isAdmin()?`<select id="payment-surgeon-filter" class="filter-select"><option value="all">All surgeons</option>${(state.doctors.length?state.doctors:await getDoctors()).map(d=>`<option value="${esc(d.doctor_id||d.id)}" ${filters.doctorId===(d.doctor_id||d.id)?'selected':''}>${esc(d.full_name)}</option>`).join('')}</select>`:''}<select id="payment-status-filter" class="filter-select"><option value="all">All payment statuses</option><option value="Pending" ${filters.status==='Pending'?'selected':''}>Pending</option><option value="Partially paid" ${filters.status==='Partially paid'?'selected':''}>Partially paid</option><option value="Paid" ${filters.status==='Paid'?'selected':''}>Paid</option></select><input id="payment-from" class="filter-select" type="date" aria-label="Surgery from date" value="${esc(filters.from)}"><input id="payment-to" class="filter-select" type="date" title="Surgery date to" aria-label="Surgery to date" value="${esc(filters.to)}"><input id="payment-payment-from" class="filter-select" type="date" title="Payment date from" aria-label="Payment from date" value="${esc(filters.paymentFrom||'')}"><input id="payment-payment-to" class="filter-select" type="date" title="Payment date to" aria-label="Payment to date" value="${esc(filters.paymentTo||'')}"><label class="check-row" style="align-items:center;white-space:nowrap"><input id="payment-unpaid-filter" type="checkbox" ${filters.unpaid?'checked':''}> Unpaid only</label><button id="apply-payment-filters" class="button secondary small">Apply</button></div>
    <section class="panel"><div class="panel-header"><div><div class="panel-title">Surgery commission ledger</div><div class="panel-subtitle">One line per completed surgery; all payments are allocated to avoid double-counting.</div></div></div><div class="table-wrap"><table><thead><tr><th>Booking / date</th>${isAdmin()?'<th>Surgeon</th>':''}<th>Surgery / fee</th><th>Rate / commission</th><th>Paid</th><th>Outstanding</th><th>Status</th>${isAdmin()?'<th></th>':''}</tr></thead><tbody id="payment-table-body">${rows||`<tr><td colspan="${isAdmin()?8:6}">${noRows('No surgery financial entries match these filters.','＄')}</td></tr>`}</tbody></table></div></section>
    <div class="section-top"><h3>Payment transaction history</h3><span class="muted">Individual and grouped payments · Reversals remain auditable</span></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Payment ID / date</th>${isAdmin()?'<th>Surgeon</th>':''}<th>Amount</th><th>Method</th><th>Reference</th><th>Status</th>${isAdmin()?'<th></th>':''}</tr></thead><tbody>${historyRows||`<tr><td colspan="${isAdmin()?7:5}">${noRows('No payment transactions recorded.','◷')}</td></tr>`}</tbody></table></div></section>`;
}

async function renderReports() {
  if (!isAdmin()) return `${pageHeading('Reports','Your access is limited to your private booking and payment information.')}<div class="panel">${noRows('Use My Bookings and My Payments to view your own records.','▥')}</div>`;
  if (!state.demo) {
    const from = $('#report-from')?.value || dateShift(todayISO(),-180), to = $('#report-to')?.value || todayISO();
    state.reportData = await api(`/api/reports/summary?from=${from}&to=${to}`);
  } else {
    state.reportData={from:dateShift(todayISO(),-180),to:todayISO(),byDoctor:state.demoDoctors.map((d,i)=>({doctor_code:d.doctor_code,full_name:d.full_name,completed:[11,8,6,4,9][i],revenue:[8500,7100,5300,4200,6400][i],commission:[1530,1420,1325,924,1088][i]})),byType:[{name:'Cataract surgery',completed:24,revenue:22000},{name:'Pterygium surgery',completed:13,revenue:7800},{name:'Eyelid surgery',completed:5,revenue:4750}],totals:{completed:38,cancelled:3,no_show:1}};
  }
  const d=state.reportData; const maxRev=Math.max(1,...d.byDoctor.map(x=>Number(x.revenue)));
  const doctorsRows=d.byDoctor.map(x=>`<tr><td><div class="table-primary">${esc(x.full_name)}</div><div class="table-secondary">${esc(x.doctor_code)}</div></td><td>${x.completed}</td><td>${fmtCurrency(x.revenue)}</td><td>${fmtCurrency(x.commission)}</td></tr>`).join('');
  const typeRows=d.byType.map(x=>`<tr><td><div class="table-primary">${esc(x.name)}</div></td><td>${x.completed}</td><td>${fmtCurrency(x.revenue)}</td></tr>`).join('');
  return `${pageHeading('Reports & analytics','Operational visibility and recorded financials for management decisions. All financial metrics reflect stored records, not estimates.',`<button class="button secondary" data-action="export-bookings">↓ Bookings CSV</button><button class="button secondary" data-action="export-payments">↓ Payments CSV</button>`)}
    <div class="toolbar"><label class="date-control">From <input id="report-from" type="date" value="${esc(d.from)}"></label><label class="date-control">To <input id="report-to" type="date" value="${esc(d.to)}"></label><button id="apply-report-filter" class="button primary">Apply dates</button></div>
    <div class="stats-row"><div class="stat-tile"><span>Completed surgeries</span><strong>${d.totals.completed}</strong></div><div class="stat-tile"><span>Cancelled bookings</span><strong>${d.totals.cancelled}</strong></div><div class="stat-tile"><span>No-shows</span><strong>${d.totals.no_show}</strong></div></div>
    <div class="split-grid"><section class="panel"><div class="panel-header"><div><div class="panel-title">Revenue by surgeon</div><div class="panel-subtitle">Eligible surgery revenue in the selected date range</div></div></div><div class="panel-body"><div class="chart-bars">${d.byDoctor.map(x=>`<div class="chart-bar-group"><span class="chart-bar-value">${fmtCurrency(x.revenue).replace('.00','')}</span><div class="chart-bar" style="height:${Math.max(4,Number(x.revenue)/maxRev*100)}%"></div><span class="chart-bar-label">${esc(x.doctor_code)}</span></div>`).join('')}</div><p class="footnote">This view uses financial entries created for completed surgeries. Missing financial entries will not be counted as recorded revenue.</p></div></section>
    <section class="panel"><div class="panel-header"><div><div class="panel-title">Surgery mix</div><div class="panel-subtitle">Completed cases by surgery type</div></div></div><div class="table-wrap"><table><thead><tr><th>Surgery type</th><th>Completed</th><th>Revenue</th></tr></thead><tbody>${typeRows}</tbody></table></div></section></div>
    <div class="section-top"><h3>Surgeon performance</h3><span class="muted">${esc(d.from)} to ${esc(d.to)}</span></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Surgeon</th><th>Completed</th><th>Eligible revenue</th><th>Commission earned</th></tr></thead><tbody>${doctorsRows}</tbody></table></div></section>`;
}

async function renderSurgeryTypes() {
  if (!isAdmin()) return `${pageHeading('Surgery types','Surgery types are managed by the PPEC administrator.')}<div class="panel">${noRows('You do not have permission to manage surgery types.','✳')}</div>`;
  const types=state.demo?state.meta.surgeryTypes: (await api('/api/surgery-types')).surgeryTypes;
  const rows=types.map(t=>`<tr><td><div class="table-primary">${esc(t.name)}</div><div class="table-secondary">ID: ${esc(String(t.id).slice(0,8))}</div></td><td>${t.default_duration_minutes} min</td><td>${badge(t.active?'active':'inactive')}</td><td><button class="button secondary small" data-action="edit-surgery-type" data-id="${esc(t.id)}">Edit</button></td></tr>`).join('');
  return `${pageHeading('Surgery types','Maintain surgery labels and default durations. Duration must be in 30-minute increments.',`<button class="button primary" data-action="add-surgery-type">＋ Add surgery type</button>`)}<section class="panel"><div class="panel-header"><div><div class="panel-title">Configured surgery types</div><div class="panel-subtitle">Changing defaults does not rewrite durations on existing bookings.</div></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Default duration</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

async function renderUsers() {
  if (!isAdmin()) return `${pageHeading('User management','Only administrators can manage access.')}<div class="panel">${noRows('You do not have permission to manage users.','♧')}</div>`;
  const docs=await getDoctors(); const rows=docs.map(d=>`<tr><td><div class="table-primary">${esc(d.full_name)}</div><div class="table-secondary">${esc(d.doctor_code)}</div></td><td>${esc(d.phone)}</td><td>${titleCase(d.doctor_type)} doctor</td><td>${badge(d.status)}</td><td>${d.password_change_required?'<span class="status pending">Password reset required</span>':'<span class="status paid">Credential set</span>'}</td><td><select class="filter-select user-status-select" data-id="${esc(d.user_id)}"><option value="active" ${d.status==='active'?'selected':''}>Active</option><option value="suspended" ${d.status==='suspended'?'selected':''}>Suspended</option><option value="inactive" ${d.status==='inactive'?'selected':''}>Inactive</option></select></td></tr>`).join('');
  return `${pageHeading('User management','Create approved doctor accounts, reset temporary credentials and suspend access when needed.',`<button class="button primary" data-action="create-doctor">＋ Create doctor account</button>`)}
    <div class="confirm-card"><div class="confirm-icon">!</div><div><strong>Public registration is disabled</strong><p>Only administrators can create and approve accounts. Doctors with a temporary password must change it before accessing any patient or booking details.</p></div></div>
    <section class="panel"><div class="panel-header"><div><div class="panel-title">Doctor access accounts</div><div class="panel-subtitle">${docs.length} account(s) · Each phone number is unique.</div></div></div><div class="table-wrap"><table><thead><tr><th>User / Doctor ID</th><th>Phone</th><th>Role</th><th>Status</th><th>Password state</th><th>Update status</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

async function renderSettings() {
  if (!isAdmin()) return `${pageHeading('System settings','System configuration is restricted to administrators.')}<div class="panel">${noRows('You do not have permission to change system settings.','⚙')}</div>`;
  let hours=state.demo?[]:(await api('/api/operating-hours')).operatingHours;
  const blockedPeriods=state.demo?[]:(await api('/api/blocked-periods')).blockedPeriods;
  if (state.demo) {
    for(let d=1;d<=6;d++){hours.push({weekday:d,session_name:'morning',start_time:'08:00',end_time:'11:00',active:true},{weekday:d,session_name:'afternoon',start_time:'14:00',end_time:'17:00',active:true});}
  }
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const rows=hours.map(h=>`<tr><td>${days[h.weekday]}</td><td>${titleCase(h.session_name)}</td><td><input class="filter-select hours-input" type="time" data-weekday="${h.weekday}" data-session="${h.session_name}" data-field="start" value="${String(h.start_time).slice(0,5)}" ${h.active?'':'disabled'}></td><td><input class="filter-select hours-input" type="time" data-weekday="${h.weekday}" data-session="${h.session_name}" data-field="end" value="${String(h.end_time).slice(0,5)}" ${h.active?'':'disabled'}></td><td><input type="checkbox" class="hours-enabled" data-weekday="${h.weekday}" data-session="${h.session_name}" ${h.active?'checked':''} aria-label="Enable ${days[h.weekday]} ${h.session_name}"></td></tr>`).join('');
  const blockedRows=blockedPeriods.map(bp=>`<tr><td>${esc(bp.title)}</td><td>${fmtDate(bp.starts_at,{day:'numeric',month:'short',year:'numeric'})} ${fmtTime(bp.starts_at)}–${fmtTime(bp.ends_at)}</td><td>${esc(bp.bed_name||'Both beds')}</td><td>${esc(bp.reason||'—')}</td><td><button class="button danger small" data-action="remove-blocked-period" data-id="${esc(bp.id)}">Deactivate</button></td></tr>`).join('');
  return `${pageHeading('System settings','Configure operating sessions and temporary closures. Dates and times use Cambodia local time (Asia/Phnom_Penh).',`<button class="button primary" id="save-hours">Save operating hours</button>`)}
    <section class="panel"><div class="panel-header"><div><div class="panel-title">Operating hours</div><div class="panel-subtitle">Default schedule: Monday–Saturday · 08:00–11:00 and 14:00–17:00.</div></div></div><div class="table-wrap"><table><thead><tr><th>Day</th><th>Session</th><th>Start</th><th>End</th><th>Enabled</th></tr></thead><tbody id="hours-table-body">${rows}</tbody></table></div><div class="panel-body"><p class="footnote">There is no regular booking session between 11:00 and 14:00. An individual surgery must fit fully within a configured session, even if both beds are available.</p></div></section>
    <div class="section-top"><h3>Active blocked periods</h3><span class="muted">Deactivating a period preserves its audit history</span></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Title</th><th>Starts / ends</th><th>Bed</th><th>Reason</th><th></th></tr></thead><tbody>${blockedRows||`<tr><td colspan="5">${noRows('No active blocked periods.','◷')}</td></tr>`}</tbody></table></div></section>
    <div class="section-top"><h3>Block a period</h3><span class="muted">Holiday, maintenance or temporary closure</span></div><section class="panel"><div class="panel-header"><div><div class="panel-title">Create a blocked period</div><div class="panel-subtitle">A closure can apply to both beds or a single bed.</div></div></div><div class="panel-body"><form id="block-period-form" class="form-grid"><div class="field-group"><label>Title</label><input name="title" required placeholder="e.g. Zeiss maintenance"></div><div class="field-group"><label>Bed</label><select name="operatingRoomId"><option value="">Both beds</option>${state.meta.rooms.map(r=>`<option value="${esc(r.id)}">${esc(r.display_name)}</option>`).join('')}</select></div><div class="field-group"><label>Starts at (Cambodia time)</label><input type="datetime-local" name="startsAt" required></div><div class="field-group"><label>Ends at (Cambodia time)</label><input type="datetime-local" name="endsAt" required></div><div class="field-group span-2"><label>Reason / notes</label><textarea name="reason" placeholder="Reason for closure"></textarea></div><div class="span-2" style="display:flex;justify-content:flex-end"><button class="button primary" type="submit">＋ Add blocked period</button></div></form></div></section>`;
}

async function renderAudit() {
  if (!isAdmin()) return `${pageHeading('Audit logs','Security-sensitive actions are visible to administrators only.')}<div class="panel">${noRows('You do not have permission to view audit logs.','◷')}</div>`;
  const logs=state.demo?state.demoAuditLogs:(await api('/api/audit-logs?limit=200')).auditLogs; state.auditLogs=logs;
  const rows=logs.map(l=>`<tr><td><div class="table-primary">${fmtDate(l.created_at,{day:'numeric',month:'short',year:'numeric'})}</div><div class="table-secondary">${fmtTime(l.created_at)}</div></td><td><div class="table-primary">${esc(l.actor_name||'System / unknown')}</div><div class="table-secondary">${esc(l.actor_phone||'')}</div></td><td><div class="table-primary">${esc(titleCase(l.action))}</div><div class="table-secondary">${esc(l.entity_type)} · ${esc(l.entity_id||'')}</div></td><td>${esc(l.reason||'—')}</td><td><button class="button secondary small" data-audit-detail="${esc(l.id)}">Details</button></td></tr>`).join('');
  return `${pageHeading('Audit logs','A chronological record of booking changes, user access, password resets and financial adjustments.',`<button class="button secondary" id="refresh-audit">↻ Refresh</button>`)}<section class="panel"><div class="panel-header"><div><div class="panel-title">Recent activity</div><div class="panel-subtitle">Showing the most recent ${logs.length} event(s). Records are append-only from the application UI.</div></div></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action / entity</th><th>Reason</th><th></th></tr></thead><tbody>${rows||`<tr><td colspan="5">${noRows('No audit entries are available.','◷')}</td></tr>`}</tbody></table></div></section>`;
}

function wirePageControls() {
  $('#calendar-prev')?.addEventListener('click',()=>{state.calendarDate=dateShift(state.calendarDate,state.calendarView==='day'?-1:state.calendarView==='week'?-7:-28);renderPage();});
  $('#calendar-next')?.addEventListener('click',()=>{state.calendarDate=dateShift(state.calendarDate,state.calendarView==='day'?1:state.calendarView==='week'?7:28);renderPage();});
  $('#calendar-today')?.addEventListener('click',()=>{state.calendarDate=todayISO();renderPage();});
  $$('[data-calendar-view]').forEach(button=>button.addEventListener('click',()=>{state.calendarView=button.dataset.calendarView;renderPage();}));
  $('#booking-search')?.addEventListener('input',filterBookingRows); $('#booking-status-filter')?.addEventListener('change',filterBookingRows);
  $('#booking-from')?.addEventListener('change',reloadBookingTable); $('#booking-to')?.addEventListener('change',reloadBookingTable);
  $('#doctor-search')?.addEventListener('input',filterDoctorRows); $('#doctor-type-filter')?.addEventListener('change',filterDoctorRows); $('#doctor-status-filter')?.addEventListener('change',filterDoctorRows);
  $('#payment-search')?.addEventListener('input',filterPaymentRows); $('#payment-surgeon-filter')?.addEventListener('change',applyPaymentFilters); $('#apply-payment-filters')?.addEventListener('click',applyPaymentFilters);
  $('#apply-report-filter')?.addEventListener('click',renderPage);
  $('#refresh-audit')?.addEventListener('click',renderPage);
  $$('[data-audit-detail]').forEach(b=>b.addEventListener('click',()=>{const log=state.auditLogs.find(x=>String(x.id)===b.dataset.auditDetail);showModal({title:'Audit event details',subtitle:'Read-only security activity record',small:true,body:`<div class="key-value"><span>Action</span><strong>${esc(log?.action)}</strong></div><div class="key-value"><span>Entity</span><strong>${esc(log?.entity_type)} / ${esc(log?.entity_id)}</strong></div><div class="key-value"><span>Actor</span><strong>${esc(log?.actor_name||'System')}</strong></div><div class="key-value"><span>Reason</span><strong>${esc(log?.reason||'—')}</strong></div><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px;color:#6e8179">${esc(JSON.stringify(log?.details||{},null,2))}</pre>`});}));
  $$('.user-status-select').forEach(sel=>sel.addEventListener('change',()=>changeUserStatus(sel.dataset.id,sel.value)));
  $('#save-hours')?.addEventListener('click',saveOperatingHours);
  $('#block-period-form')?.addEventListener('submit',createBlockedPeriod);
}
function filterBookingRows() {
  const q=($('#booking-search')?.value||'').toLowerCase(), status=$('#booking-status-filter')?.value||'all';
  $$('#booking-table-body tr').forEach(tr=>{const text=tr.textContent.toLowerCase();tr.classList.toggle('hidden',(!text.includes(q))||(status!=='all'&&!text.includes(status.replace('_','-'))&&!text.includes(status)));});
}
function filterDoctorRows() {
  const q=($('#doctor-search')?.value||'').toLowerCase(), type=$('#doctor-type-filter')?.value||'all', status=$('#doctor-status-filter')?.value||'all';
  $$('#doctor-table-body tr').forEach(tr=>{const txt=tr.textContent.toLowerCase();tr.classList.toggle('hidden',!txt.includes(q)||(type!=='all'&&!txt.includes(type))||(status!=='all'&&!txt.includes(status)));});
}
function filterPaymentRows() {
  const q=($('#payment-search')?.value||'').toLowerCase(); $$('#payment-table-body tr').forEach(tr=>tr.classList.toggle('hidden',!tr.textContent.toLowerCase().includes(q)));
}
async function reloadBookingTable() { const content=$('#page-content'); await renderPage(); }
async function applyPaymentFilters() {
  const doctorId=$('#payment-surgeon-filter')?.value||'all';
  state.currentPaymentFilters={status:$('#payment-status-filter')?.value||'all',unpaid:$('#payment-unpaid-filter')?.checked||false,from:$('#payment-from')?.value||'',to:$('#payment-to')?.value||'',paymentFrom:$('#payment-payment-from')?.value||'',paymentTo:$('#payment-payment-to')?.value||'',doctorId};
  renderPage();
}

function findBooking(id) {
  return (state.calendar||[]).find(b=>b.id===id) || (state.currentBookings||[]).find(b=>b.id===id) || (state.currentCalendarBookings||[]).find(b=>b.id===id);
}
function configuredSessions(dateValue) {
  const [y,m,d]=String(dateValue||todayISO()).split('-').map(Number);
  const weekday=new Date(Date.UTC(y,m-1,d,12)).getUTCDay();
  let sessions=(state.meta.operatingHours||[]).filter(h=>Number(h.weekday)===weekday&&h.active!==false);
  if(!sessions.length&&!((state.meta.operatingHours||[]).length)&&weekday>=1&&weekday<=6) sessions=[{start_time:'08:00',end_time:'11:00'},{start_time:'14:00',end_time:'17:00'}];
  return sessions;
}
function getTimeSlotsForDate(dateValue) {
  const sessions=configuredSessions(dateValue),times=[];
  for(const session of sessions){
    const a=String(session.start_time||session.startTime).slice(0,5),b=String(session.end_time||session.endTime).slice(0,5);
    if(!/^\d{2}:\d{2}$/.test(a)||!/^\d{2}:\d{2}$/.test(b))continue;
    let [h,m]=a.split(':').map(Number),[eh,em]=b.split(':').map(Number);
    while(h<eh||(h===eh&&m<em)){times.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);m+=30;if(m>=60){m-=60;h++;}}
  }
  return [...new Set(times)].sort();
}
function timeOptions(selected='08:00',dateValue=todayISO()) {
  const times=getTimeSlotsForDate(dateValue);
  if(!times.length)return '<option value="" selected disabled>No operating session configured for this date</option>';
  if(selected&&!times.includes(selected))times.push(selected);
  return times.sort().map(t=>`<option value="${t}" ${t===selected?'selected':''}>${t}</option>`).join('');
}
function openBookingModal(existing=null) {
  state.pendingBooking={existing};
  const minimumLeadDate=dateShift(todayISO(),3);const defaultDate=existing?.start_at?.slice(0,10)||(state.calendarDate>minimumLeadDate?state.calendarDate:minimumLeadDate);
  const defaultTime=existing?.start_at?fmtTime(existing.start_at):'08:00';
  const defaultType=existing?.surgery_type_id||state.meta.surgeryTypes[0]?.id;
  const type=state.meta.surgeryTypes.find(x=>x.id===defaultType)||state.meta.surgeryTypes[0];
  const roomId=existing?.operating_room_id||state.meta.rooms[0]?.id;
  const docOptions=isAdmin()?`<div class="field-group span-2"><label>Surgeon / booking owner</label><select name="doctorId" required>${state.doctors.map(d=>`<option value="${esc(d.doctor_id||d.id)}" ${((existing?.doctor_id===d.doctor_id||existing?.doctor_id===d.id))?'selected':''}>${esc(d.full_name)} · ${esc(d.doctor_code)}</option>`).join('')}</select></div>`:'';
  const overrideFields=isAdmin()?`<div class="field-group span-2"><label class="check-row"><input name="overrideRules" type="checkbox"> Override a booking rule (requires reason)</label><input name="overrideReason" placeholder="Required reason when overriding"></div>`:'';
  showModal({title:existing?'Reschedule surgery':'Create surgery booking',subtitle:existing?`Reschedule ${existing.booking_code}; the existing record will be retained in history.`:'Choose a bed and slot, then enter the required patient details.',body:`<form id="booking-form"><div class="modal-section-label">Surgery details</div><div class="form-grid">${docOptions}<div class="field-group"><label>Surgery date</label><input name="date" type="date" min="${todayISO()}" value="${esc(defaultDate)}" required></div><div class="field-group"><label>Start time</label><select name="startTime" required>${timeOptions(defaultTime,defaultDate)}</select><small class="field-hint">Morning 08:00–11:00 · Afternoon 14:00–17:00</small></div><div class="field-group"><label>Operating room bed</label><select name="operatingRoomId" required>${state.meta.rooms.map(r=>`<option value="${esc(r.id)}" ${roomId===r.id?'selected':''}>${esc(r.display_name)}</option>`).join('')}</select></div><div class="field-group"><label>Surgery type</label><select name="surgeryTypeId" id="booking-type" required>${state.meta.surgeryTypes.map(t=>`<option value="${esc(t.id)}" data-duration="${t.default_duration_minutes}" ${t.id===defaultType?'selected':''}>${esc(t.name)} (${t.default_duration_minutes} min)</option>`).join('')}</select></div><div class="field-group"><label>Duration</label><select name="durationMinutes" id="booking-duration">${[30,60,90,120,150,180,210,240,270,300,330,360].map(d=>`<option value="${d}" ${d===(existing?Math.round((new Date(existing.end_at)-new Date(existing.start_at))/60000):type?.default_duration_minutes)?'selected':''}>${d} minutes</option>`).join('')}</select></div><div class="field-group"><label>Operated eye</label><select name="operatedEye" required><option value="RE" ${existing?.operated_eye==='RE'?'selected':''}>RE · Right eye</option><option value="LE" ${existing?.operated_eye==='LE'?'selected':''}>LE · Left eye</option><option value="BE" ${existing?.operated_eye==='BE'?'selected':''}>BE · Both eyes</option></select></div></div>
    <div class="modal-section-label">Patient details</div><div class="form-grid"><div class="field-group"><label>Patient full name *</label><input name="patientName" value="${esc(existing?.patient_name||'')}" maxlength="180" required></div><div class="field-group"><label>Patient phone number *</label><input name="patientPhone" type="tel" value="${esc(existing?.patient_phone||'')}" maxlength="40" required></div><div class="field-group"><label>PPEC Patient ID (if available)</label><input name="ppecPatientId" value="${esc(existing?.ppec_patient_id||'')}" maxlength="80" placeholder="e.g. 11016"></div><div class="field-group"><label>Patient record link (optional)</label><input name="patientRecordUrl" type="url" value="${esc(existing?.external_record_url||'')}" placeholder="https://…"><small class="field-hint">A reference link only; this platform does not import records.</small></div><div class="field-group span-2"><label>Preoperative / logistical notes</label><textarea name="notes" maxlength="2000" placeholder="Optional, minimum necessary information">${esc(existing?.notes||'')}</textarea></div>${overrideFields}</div><div class="form-error hidden" id="booking-error"></div><div class="confirm-card"><div class="confirm-icon">✓</div><div><strong>Booking rules</strong><p>Book at least 48 hours ahead. Cancellation requires at least 24 hours’ notice. A slot is not reserved until the server confirms it.</p></div></div><div style="display:flex;justify-content:flex-end;margin-top:18px"><button class="button primary" type="submit">Review booking →</button></div></form>`,onReady(root){
      const form=$('#booking-form',root); const typeSelect=$('#booking-type',root); typeSelect?.addEventListener('change',()=>{const duration=Number(typeSelect.selectedOptions[0].dataset.duration);$('#booking-duration',root).value=String(duration);}); $('#booking-form [name=date]')?.addEventListener('change',e=>{const select=$('#booking-form [name=startTime]',root);const selected=select.value;select.innerHTML=timeOptions(selected,e.target.value);});
      form.addEventListener('submit',e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form).entries());data.durationMinutes=Number(data.durationMinutes);data.overrideRules=data.overrideRules==='on'; if(!data.overrideRules)data.overrideReason='';state.pendingBooking={existing,data};renderBookingConfirmation(data,existing);});
    }});
}
function renderBookingConfirmation(data,existing) {
  const type=state.meta.surgeryTypes.find(t=>t.id===data.surgeryTypeId);const room=state.meta.rooms.find(r=>r.id===data.operatingRoomId);const end=new Date(new Date(`${data.date}T${data.startTime}:00+07:00`).getTime()+data.durationMinutes*60000);const endTime=new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hour12:false}).format(end);
  showModal({title:'Confirm booking details',subtitle:'Please review all details carefully before saving.',body:`<div class="confirm-card"><div class="confirm-icon">▣</div><div><strong>${esc(type?.name||'Surgery')}</strong><p>${fmtDateLong(data.date)} · ${esc(data.startTime)}–${endTime} · ${esc(room?.display_name||'Operating bed')} · ${data.durationMinutes} minutes</p></div></div><div class="key-value"><span>Patient</span><strong>${esc(data.patientName)}</strong></div><div class="key-value"><span>Phone number</span><strong>${esc(data.patientPhone)}</strong></div><div class="key-value"><span>PPEC Patient ID</span><strong>${esc(data.ppecPatientId||'Not provided')}</strong></div><div class="key-value"><span>Operated eye</span><strong>${esc(data.operatedEye)}</strong></div>${isAdmin()?`<div class="key-value"><span>Surgeon</span><strong>${esc(state.doctors.find(d=>(d.doctor_id||d.id)===data.doctorId)?.full_name||'Selected surgeon')}</strong></div>`:''}<p class="footnote" style="margin-top:15px">The application will recheck operating sessions, closure periods, booking lead time and bed conflicts before committing this booking.</p>`,footer:`<button class="button secondary" id="edit-booking-details">← Edit details</button><button class="button primary" id="confirm-booking-save">${existing?'Confirm reschedule':'Confirm booking'}</button>`,onReady(root){$('#edit-booking-details',root).addEventListener('click',()=>openBookingModal(existing));$('#confirm-booking-save',root).addEventListener('click',()=>saveBooking(data,existing));}});
}
async function saveBooking(data,existing) {
  const button=$('#confirm-booking-save');if(button){button.disabled=true;button.textContent='Saving…';}
  const body={...data};
  if(body.overrideReason&&!body.overrideReason.trim())body.overrideReason='';
  try {
    if(state.demo) {
      if(data.overrideRules&&!data.overrideReason) throw new Error('Enter a reason for the administrator override.');
      const start=new Date(`${data.date}T${data.startTime}:00+07:00`),end=new Date(start.getTime()+data.durationMinutes*60000);
      const conflict=state.calendar.some(b=>(!existing||b.id!==existing.id)&&b.bed_code===state.meta.rooms.find(r=>r.id===data.operatingRoomId)?.code&&!['cancelled','rescheduled'].includes(b.status)&&new Date(b.start_at)<end&&new Date(b.end_at)>start);
      if(conflict)throw new Error('This bed conflicts with another booking. Choose another slot.');
      const hours=(start-Date.now())/3600000;if(hours<48&&!data.overrideRules)throw new Error('Bookings must be made at least 48 hours in advance.');
      const booking={id:existing?.id||`demo-booking-${Date.now()}`,booking_code:existing?.booking_code||`PPEC-DEMO-${Math.floor(Math.random()*900+100)}`,doctor_id:data.doctorId||state.user.doctorId||'doc-1',doctor_name:state.doctors.find(d=>(d.doctor_id||d.id)===(data.doctorId||state.user.doctorId))?.full_name||state.user.fullName,doctor_code:'DEMO',start_at:start.toISOString(),end_at:end.toISOString(),status:'confirmed',bed_code:state.meta.rooms.find(r=>r.id===data.operatingRoomId)?.code,bed_name:state.meta.rooms.find(r=>r.id===data.operatingRoomId)?.display_name,operating_room_id:data.operatingRoomId,surgery_type:state.meta.surgeryTypes.find(t=>t.id===data.surgeryTypeId)?.name,surgery_type_id:data.surgeryTypeId,patient_name:data.patientName,patient_phone:data.patientPhone,ppec_patient_id:data.ppecPatientId,external_record_url:data.patientRecordUrl,notes:data.notes,isMine:true};
      if(existing){state.calendar=state.calendar.map(b=>b.id===existing.id?{...b,status:'rescheduled'}:b);state.calendar.push(booking);} else state.calendar.push(booking);
    } else {
      if(data.overrideRules&&!data.overrideReason?.trim())throw new Error('An administrator override requires a reason.');
      if(existing) await api(`/api/bookings/${existing.id}/reschedule`,{method:'POST',body:{...body,reason:data.overrideReason||'Rescheduled by booking owner',overrideRules:data.overrideRules}});
      else await api('/api/bookings',{method:'POST',body});
    }
    closeModal();setToast(existing?'Booking rescheduled successfully.':'Booking confirmed successfully.');state.page='bookings';renderNavigation();await renderPage();
  } catch(e) {const root=$('#modal-root');const error=$('#booking-error',root);if(error){error.textContent=e.message;error.classList.remove('hidden');}else setToast(e.message,'error'); if(button){button.disabled=false;button.textContent=existing?'Confirm reschedule':'Confirm booking';}}
}
function openBookingDetail(id) {
  const b=findBooking(id);if(!b)return;
  const privateOther=b.isMine===false&&!isAdmin();if(privateOther)return;
  const canManage=b.status==='confirmed'&&(isAdmin()||b.doctor_id===state.user.doctorId||b.doctor_id===state.user.doctor_id);
  const footer=[];
  if(canManage){footer.push(`<button class="button secondary" data-action="reschedule-booking" data-id="${esc(b.id)}">Reschedule</button><button class="button danger" data-action="cancel-booking" data-id="${esc(b.id)}">Cancel</button>`);}
  if(isAdmin()&&b.status==='confirmed'){footer.push(`<button class="button secondary" data-action="mark-status" data-status="completed" data-id="${esc(b.id)}">Mark completed</button><button class="button secondary" data-action="mark-status" data-status="no_show" data-id="${esc(b.id)}">No-show</button>`);}
  if(isAdmin()&&b.status==='completed'){footer.push(`<button class="button primary" data-action="record-financial" data-id="${esc(b.id)}">Record surgery fee</button>`);}
  showModal({title:`Booking ${b.booking_code}`,subtitle:'Surgery details and booking history',body:`<div class="profile-card" style="padding:0 0 18px"><div class="profile-large-avatar">▣</div><div class="profile-main"><h3>${esc(b.surgery_type)}</h3><p>${fmtDateLong(b.start_at)}<br>${fmtTime(b.start_at)}–${fmtTime(b.end_at)} · ${esc(b.bed_name||`Bed ${b.bed_code}`)}</p></div>${badge(b.status)}</div><div class="modal-section-label">Patient information</div><div class="key-value"><span>Patient name</span><strong>${esc(b.patient_name||'—')}</strong></div><div class="key-value"><span>Phone</span><strong>${esc(b.patient_phone||'—')}</strong></div><div class="key-value"><span>PPEC Patient ID</span><strong>${esc(b.ppec_patient_id||'—')}</strong></div>${isAdmin()?`<div class="key-value"><span>Surgeon</span><strong>${esc(b.doctor_name)} · ${esc(b.doctor_code)}</strong></div>`:''}<div class="key-value"><span>Notes</span><strong>${esc(b.notes||'—')}</strong></div>${b.cancellation_reason?`<div class="key-value"><span>Cancellation reason</span><strong>${esc(b.cancellation_reason)}</strong></div>`:''}<p class="footnote" style="margin-top:13px">Booking ID: ${esc(b.booking_code)}. Past records are retained for audit purposes.</p>`,footer:footer.join('')+'<button class="button secondary" data-action="close-modal">Close</button>',onReady(root){attachGlobalActions(root);}});
}
async function cancelBooking(id) {
  const b=findBooking(id);if(!b)return;
  showModal({title:'Cancel this booking?',subtitle:`${b.booking_code} · ${fmtDateLong(b.start_at)} at ${fmtTime(b.start_at)}`,small:true,body:`<p style="font-size:12px;line-height:1.7;color:#6e827a">The booking record will remain in the system with cancelled status. A cancelled slot becomes available again.</p><div class="field-group"><label>Reason (optional for regular cancellation)</label><textarea id="cancel-reason" placeholder="Brief reason for cancellation"></textarea></div>${isAdmin()?'<label class="check-row" style="margin-top:13px"><input id="cancel-override" type="checkbox"> Override the 24-hour cancellation rule (reason required)</label>':''}`,footer:'<button class="button secondary" data-action="close-modal">Keep booking</button><button class="button danger" id="confirm-cancel">Cancel booking</button>',onReady(root){$('#confirm-cancel',root).addEventListener('click',async()=>{const reason=$('#cancel-reason',root).value;const override=$('#cancel-override',root)?.checked||false;try{if(state.demo){const hours=(new Date(b.start_at)-Date.now())/3600000;if(hours<24&&!isAdmin())throw new Error('Bookings can only be cancelled at least 24 hours in advance.');if(hours<24&&isAdmin()&&(!override||reason.trim().length<5))throw new Error('An administrator override requires a reason of at least 5 characters.');state.calendar=state.calendar.map(x=>x.id===id?{...x,status:'cancelled',cancellation_reason:reason}:x);}else await api(`/api/bookings/${id}/cancel`,{method:'POST',body:{reason,override}});closeModal();setToast('Booking cancelled.');renderPage();}catch(e){setToast(e.message,'error');}});}});
}
async function updateBookingStatus(id,status) {
  try{if(state.demo){state.calendar=state.calendar.map(b=>b.id===id?{...b,status}:b);closeModal();setToast(`Booking marked ${statusLabel(status).toLowerCase()}.`);renderPage();return;}await api(`/api/bookings/${id}/status`,{method:'POST',body:{status}});closeModal();setToast(`Booking marked ${statusLabel(status).toLowerCase()}.`);renderPage();}catch(e){setToast(e.message,'error');}
}

function openDoctorModal() {
  if(!isAdmin())return;
  showModal({title:'Create approved surgeon account',subtitle:'The doctor can sign in only after you share their one-time temporary password.',body:`<form id="doctor-create-form"><div class="form-grid"><div class="field-group"><label>Full name *</label><input name="fullName" required maxlength="160" placeholder="Dr. Full Name"></div><div class="field-group"><label>Registered phone *</label><input name="phone" required maxlength="32" placeholder="855…"></div><div class="field-group"><label>Unique Doctor ID *</label><input name="doctorCode" required maxlength="40" placeholder="PPEC-### / EXT-###"></div><div class="field-group"><label>Doctor category *</label><select name="doctorType" required><option value="internal">Internal doctor</option><option value="external">External doctor</option></select></div><div class="field-group"><label>Email (optional)</label><input name="email" type="email" maxlength="254"></div><div class="field-group"><label>Medical license number</label><input name="medicalLicenseNumber" maxlength="100"></div><div class="field-group"><label>Licensing authority</label><input name="licensingAuthority" maxlength="160"></div><div class="field-group"><label>Primary workplace</label><input name="workplace" maxlength="200"></div><div class="field-group"><label>Commission percentage</label><input name="commissionPercentage" type="number" min="0" max="100" step="0.01" value="0" required></div><div class="field-group"><label>Payment method</label><select name="paymentMethod"><option value="">Not set</option><option>Bank transfer</option><option>Cash</option><option>Mobile payment</option><option>Other</option></select></div><div class="field-group span-2"><label>Temporary password (optional)</label><input name="temporaryPassword" type="text" minlength="1" maxlength="100" placeholder="Leave blank to generate a secure one-time password"><small class="field-hint">For real accounts, use the generated secure password rather than a shared/simple credential. The password is shown once and is not retrievable later.</small></div></div><div id="doctor-create-error" class="form-error hidden" style="margin-top:13px"></div><div style="display:flex;justify-content:flex-end;margin-top:18px"><button class="button primary" type="submit">Create account</button></div></form>`,onReady(root){$('#doctor-create-form',root).addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget).entries());data.commissionPercentage=Number(data.commissionPercentage);try{let result;if(state.demo){if(state.demoDoctors.some(d=>d.phone===data.phone||d.doctor_code===data.doctorCode))throw new Error('Phone number or Doctor ID already exists.');const doc={doctor_id:`doc-${Date.now()}`,user_id:`user-${Date.now()}`,doctor_code:data.doctorCode,full_name:data.fullName,phone:data.phone,email:data.email,doctor_type:data.doctorType,status:'active',commission_percentage:data.commissionPercentage,workplace:data.workplace,medical_license_number:data.medicalLicenseNumber,licensing_authority:data.licensingAuthority,payment_method:data.paymentMethod,password_change_required:true};state.demoDoctors.push(doc);state.doctors=state.demoDoctors;result={doctor:doc,temporaryPassword:data.temporaryPassword||randomDemoPassword()};}else result=await api('/api/doctors',{method:'POST',body:data});showModal({title:'Doctor account created',subtitle:'Copy the temporary password now. It will not be shown again.',body:`<div class="confirm-card"><div class="confirm-icon">✓</div><div><strong>${esc(result.doctor.full_name||result.doctor.fullName||data.fullName)}</strong><p>${esc(result.doctor.doctor_code||data.doctorCode)} · ${esc(data.phone)}</p></div></div><div class="field-group"><label>Temporary password</label><div style="display:flex;gap:8px"><input id="created-temp-password" readonly value="${esc(result.temporaryPassword)}"><button class="button secondary" id="copy-temp-password">Copy</button></div></div><div class="confirm-card"><div class="confirm-icon">!</div><div><strong>Required on first sign-in</strong><p>The doctor must set a personal password of at least 12 characters before accessing the system.</p></div></div>`,footer:'<button class="button primary" data-action="close-modal">Done</button>',onReady(root){$('#copy-temp-password',root).addEventListener('click',async()=>{try{await navigator.clipboard.writeText(result.temporaryPassword);setToast('Temporary password copied.');}catch{ $('#created-temp-password',root).select();document.execCommand('copy');setToast('Copy the selected temporary password.');}});}});setToast('Doctor account created.');}catch(err){const el=$('#doctor-create-error',root);el.textContent=err.message;el.classList.remove('hidden');}});}});
}
function randomDemoPassword(){return `Demo-${Math.random().toString(36).slice(2,8)}-A9!`;}
async function openResetPasswordModal(id) {
  const d=(state.doctors||[]).find(x=>(x.doctor_id||x.id)===id);if(!d)return;
  showModal({title:'Reset temporary password',subtitle:`${d.full_name} · ${d.doctor_code}`,small:true,body:`<p class="muted" style="font-size:11px;line-height:1.7">The current password will stop working. The doctor will be required to set a new personal password at their next sign-in.</p><div class="field-group"><label>Temporary password (optional)</label><input id="reset-password-value" placeholder="Blank = generate secure password"><small class="field-hint">Production recommendation: generate a unique credential, not a shared default.</small></div>`,footer:'<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" id="do-reset-password">Reset password</button>',onReady(root){$('#do-reset-password',root).addEventListener('click',async()=>{const temp=$('#reset-password-value',root).value;try{let value;if(state.demo)value=temp||randomDemoPassword();else{const result=await api(`/api/doctors/${id}/reset-password`,{method:'POST',body:{temporaryPassword:temp||undefined}});value=result.temporaryPassword;}showModal({title:'Temporary password reset',subtitle:'This credential is displayed once.',small:true,body:`<div class="field-group"><label>Temporary password</label><div style="display:flex;gap:8px"><input id="reset-output" readonly value="${esc(value)}"><button class="button secondary" id="copy-reset-output">Copy</button></div></div><p class="footnote">Share this credential securely with the doctor. They must change it on next sign-in.</p>`,footer:'<button class="button primary" data-action="close-modal">Done</button>',onReady(root2){$('#copy-reset-output',root2).addEventListener('click',async()=>{try{await navigator.clipboard.writeText(value);setToast('Temporary password copied.');}catch{$('#reset-output',root2).select();document.execCommand('copy');}});}});}catch(e){setToast(e.message,'error');}});}});
}
async function updateDoctorStatus(doctorId,status){try{const d=(state.doctors||[]).find(x=>(x.doctor_id||x.id)===doctorId);if(state.demo){d.status=status;}else await api(`/api/users/${d.user_id||doctorId}/status`,{method:'PATCH',body:{status}});setToast(`Account status updated to ${status}.`);renderPage();}catch(e){setToast(e.message,'error');}}
function openDoctorEditModal(id){
  if(!isAdmin())return;
  const d=(state.doctors||[]).find(x=>(x.doctor_id||x.id)===id);if(!d)return;
  showModal({title:'Edit surgeon profile',subtitle:'Restricted professional and commission fields can only be changed by administrators.',body:`<form id="doctor-edit-form"><div class="form-grid"><div class="field-group span-2"><label>Full name *</label><input name="fullName" maxlength="160" required value="${esc(d.full_name||'')}"></div><div class="field-group"><label>Registered phone *</label><input name="phone" maxlength="32" required value="${esc(d.phone||'')}"></div><div class="field-group"><label>Email address</label><input name="email" type="email" maxlength="254" value="${esc(d.email||'')}"></div><div class="field-group"><label>Doctor ID *</label><input name="doctorCode" maxlength="40" required value="${esc(d.doctor_code||'')}"></div><div class="field-group"><label>Doctor category *</label><select name="doctorType"><option value="internal" ${d.doctor_type==='internal'?'selected':''}>Internal PPEC</option><option value="external" ${d.doctor_type==='external'?'selected':''}>External ophthalmologist</option></select></div><div class="field-group"><label>Medical license number</label><input name="medicalLicenseNumber" maxlength="100" value="${esc(d.medical_license_number||'')}"></div><div class="field-group"><label>Licensing authority</label><input name="licensingAuthority" maxlength="160" value="${esc(d.licensing_authority||'')}"></div><div class="field-group span-2"><label>Primary workplace</label><input name="workplace" maxlength="200" value="${esc(d.workplace||'')}"></div><div class="field-group"><label>Commission percentage *</label><input name="commissionPercentage" type="number" min="0" max="100" step="0.01" required value="${Number(d.commission_percentage||0)}"></div><div class="field-group"><label>Preferred payment method</label><select name="paymentMethod"><option value="" ${!d.payment_method?'selected':''}>Not set</option><option value="Bank transfer" ${d.payment_method==='Bank transfer'?'selected':''}>Bank transfer</option><option value="Cash" ${d.payment_method==='Cash'?'selected':''}>Cash</option><option value="Mobile payment" ${d.payment_method==='Mobile payment'?'selected':''}>Mobile payment</option><option value="Other" ${d.payment_method==='Other'?'selected':''}>Other</option></select></div></div><div id="doctor-edit-error" class="form-error hidden" style="margin-top:12px"></div><div style="display:flex;justify-content:flex-end;margin-top:18px"><button class="button primary" type="submit">Save surgeon profile</button></div></form>`,onReady(root){$('#doctor-edit-form',root).addEventListener('submit',async e=>{e.preventDefault();const form=Object.fromEntries(new FormData(e.currentTarget).entries());const body={...form,commissionPercentage:Number(form.commissionPercentage)};try{if(state.demo){Object.assign(d,{full_name:body.fullName,phone:body.phone,email:body.email,doctor_code:body.doctorCode,doctor_type:body.doctorType,medical_license_number:body.medicalLicenseNumber,licensing_authority:body.licensingAuthority,workplace:body.workplace,commission_percentage:body.commissionPercentage,payment_method:body.paymentMethod});}else await api(`/api/doctors/${id}`,{method:'PATCH',body});closeModal();setToast('Surgeon profile updated.');renderPage();}catch(err){const el=$('#doctor-edit-error',root);el.textContent=err.message;el.classList.remove('hidden');}});}});
}

function openDoctorDetail(id){const d=(state.doctors||[]).find(x=>(x.doctor_id||x.id)===id);if(!d)return;showModal({title:'Surgeon profile',subtitle:`${d.doctor_code} · ${titleCase(d.doctor_type)} doctor`,body:`<div class="profile-card" style="padding:0 0 17px"><div class="profile-large-avatar">${initials(d.full_name)}</div><div class="profile-main"><h3>${esc(d.full_name)}</h3><p>${esc(d.workplace||'Workplace not recorded')}<br>${esc(d.phone)} · ${esc(d.email||'No email')}</p></div>${badge(d.status)}</div><div class="key-value"><span>Medical license</span><strong>${esc(d.medical_license_number||'Not recorded')}</strong></div><div class="key-value"><span>Licensing authority</span><strong>${esc(d.licensing_authority||'Not recorded')}</strong></div><div class="key-value"><span>Commission rate</span><strong>${Number(d.commission_percentage||0).toFixed(2)}%</strong></div><div class="key-value"><span>Payment method</span><strong>${esc(d.payment_method||'Not set')}</strong></div><p class="footnote" style="margin-top:14px">Medical license information, contact details and payment settings are confidential. Only administrators may edit restricted profile fields.</p>`,footer:`<button class="button secondary" data-action="edit-doctor" data-id="${esc(id)}">Edit profile</button><button class="button secondary" data-action="reset-password" data-id="${esc(id)}">Reset password</button><button class="button secondary" data-action="close-modal">Close</button>` ,onReady(root){attachGlobalActions(root);}});}

function openFinancialModal(id){const b=findBooking(id);if(!b)return;const doctor=(state.doctors||[]).find(d=>(d.doctor_id||d.id)===b.doctor_id);showModal({title:'Record surgery financials',subtitle:`${b.booking_code} · ${b.surgery_type}`,body:`<div class="confirm-card"><div class="confirm-icon">＄</div><div><strong>${esc(b.patient_name)} · ${esc(b.bed_name||`Bed ${b.bed_code}`)}</strong><p>Only completed surgeries can be added to the commission ledger.</p></div></div><form id="financial-form"><div class="form-grid"><div class="field-group"><label>Actual eligible surgery fee (USD)</label><input name="eligibleSurgeryFee" type="number" min="0" step="0.01" required></div><div class="field-group"><label>Commission percentage snapshot</label><input name="commissionPercentageSnapshot" type="number" min="0" max="100" step="0.01" value="${Number(doctor?.commission_percentage||0)}" required></div><div class="field-group span-2"><label>Notes / adjustments policy</label><textarea name="notes" placeholder="Record whether discounts or charges are included"></textarea></div></div><div class="confirm-card"><div class="confirm-icon">✓</div><div><strong>Commission calculation</strong><p id="commission-preview">Enter the fee to calculate surgeon commission.</p></div></div><div class="form-error hidden" id="financial-error"></div><div style="display:flex;justify-content:flex-end;margin-top:15px"><button class="button primary" type="submit">Save financial record</button></div></form>`,onReady(root){const form=$('#financial-form',root);const update=()=>{const fee=Number(form.elements.eligibleSurgeryFee.value||0),pct=Number(form.elements.commissionPercentageSnapshot.value||0);$('#commission-preview',root).textContent=`${fmtCurrency(fee)} × ${pct}% = ${fmtCurrency(fee*pct/100)}`;};form.addEventListener('input',update);form.addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form).entries());data.eligibleSurgeryFee=Number(data.eligibleSurgeryFee);data.commissionPercentageSnapshot=Number(data.commissionPercentageSnapshot);try{if(state.demo){const old=state.demoPayments.find(x=>x.booking_id===id);const pct=data.commissionPercentageSnapshot,fee=data.eligibleSurgeryFee,commission=Math.round((fee*pct/100)*100)/100;const record={id:old?.id||`fin-${Date.now()}`,booking_id:id,booking_code:b.booking_code,doctor_id:b.doctor_id,doctor_code:b.doctor_code,doctor_name:b.doctor_name,patient_reference:b.ppec_patient_id,surgery_type_name:b.surgery_type,completed_on:b.start_at.slice(0,10),eligible_surgery_fee:fee,commission_percentage_snapshot:pct,commission_amount:commission,adjustment_amount:0,total_paid:old?.total_paid||0,outstanding:commission-(old?.total_paid||0),payment_status:(old?.total_paid||0)>=commission?'Paid':(old?.total_paid||0)>0?'Partially paid':'Pending',last_payment_date:old?.last_payment_date};if(old)state.demoPayments=state.demoPayments.map(x=>x.id===old.id?record:x);else state.demoPayments.unshift(record);}else await api(`/api/bookings/${id}/financials`,{method:'POST',body:data});closeModal();setToast('Surgery financial record saved.');state.page='payments';renderNavigation();renderPage();}catch(err){const el=$('#financial-error',root);el.textContent=err.message;el.classList.remove('hidden');}});}});}

function openFinancialAdjustmentModal(id){
  if(!isAdmin())return;
  const p=state.payments.find(x=>x.id===id);if(!p)return;
  showModal({title:'Adjust surgeon commission',subtitle:`${p.booking_code} · ${p.doctor_name} · Existing earned amount ${fmtCurrency(Number(p.commission_amount)+Number(p.adjustment_amount||0) )}`,small:true,body:`<form id="financial-adjustment-form"><div class="field-group"><label>Adjustment amount (USD; use a negative value to reduce) *</label><input name="adjustmentAmount" type="number" step="0.01" required placeholder="e.g. 25.00 or -10.00"></div><div class="field-group" style="margin-top:13px"><label>Reason *</label><textarea name="reason" required minlength="5" maxlength="1000" placeholder="Document the reason for this adjustment"></textarea></div><div class="form-error hidden" id="adjustment-error" style="margin-top:12px"></div><div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="button primary" type="submit">Save adjustment</button></div></form>`,onReady(root){$('#financial-adjustment-form',root).addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.currentTarget),amount=Number(fd.get('adjustmentAmount')),reason=String(fd.get('reason')||'').trim();try{if(!Number.isFinite(amount)||Math.abs(amount*100-Math.round(amount*100))>0.000001||reason.length<5)throw new Error('Enter an adjustment amount to two decimal places and a reason of at least five characters.');const newEarned=Number(p.commission_amount)+Number(p.adjustment_amount||0)+amount;if(newEarned<Number(p.total_paid)-0.00001||newEarned<0)throw new Error('The adjustment cannot make commission negative or lower than payments already recorded.');if(state.demo){p.adjustment_amount=Number(p.adjustment_amount||0)+amount;p.outstanding=Math.round((newEarned-Number(p.total_paid))*100)/100;p.payment_status=p.outstanding<=0?'Paid':Number(p.total_paid)>0?'Partially paid':'Pending';}else await api(`/api/surgery-financials/${id}/adjust`,{method:'POST',body:{adjustmentAmount:amount,reason}});closeModal();setToast('Financial adjustment saved with an audit trail.');renderPage();}catch(err){const el=$('#adjustment-error',root);el.textContent=err.message;el.classList.remove('hidden');}});}});
}

async function openPaymentModal(prefillFinancialId=null, selectedDoctorId=''){
  if(!isAdmin())return;
  const doctors=state.doctors.length?state.doctors:await getDoctors();
  const response=await loadPayments({unpaid:true});
  state.payments=response.items;
  const payable=state.payments.filter(p=>Number(p.outstanding)>0&&(p.payment_status==='Pending'||p.payment_status==='Partially paid'));
  const doctorId=selectedDoctorId || (prefillFinancialId?payable.find(p=>p.id===prefillFinancialId)?.doctor_id:'');
  const filtered=doctorId?payable.filter(p=>p.doctor_id===doctorId):[];
  const recordRows=filtered.map(p=>`<label class="payment-allocation-row" style="display:grid;grid-template-columns:20px minmax(0,1fr) 100px;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line);font-size:10px"><input type="checkbox" name="financialIds" value="${esc(p.id)}" data-outstanding="${Number(p.outstanding)}"><span><strong style="display:block">${esc(p.booking_code)} · ${esc(p.surgery_type_name)}</strong><small style="display:block;color:#95a49e;margin-top:4px">${esc(p.doctor_name)} · Owed ${fmtCurrency(p.outstanding)}</small></span><input type="number" min="0.01" max="${Number(p.outstanding)}" step="0.01" value="${Number(p.outstanding).toFixed(2)}" name="amount-${esc(p.id)}" disabled style="width:100%;border:1px solid var(--line-2);border-radius:6px;padding:7px;font-size:10px"></label>`).join('');
  showModal({title:'Record surgeon payment',subtitle:'Select one or more outstanding surgery commissions. The payment total is calculated from allocations.',body:`<form id="payment-form"><div class="form-grid"><div class="field-group span-2"><label>Surgeon *</label><select id="payment-doctor-id" name="doctorId" required><option value="">Choose a surgeon</option>${doctors.map(d=>`<option value="${esc(d.doctor_id||d.id)}" ${doctorId===(d.doctor_id||d.id)?'selected':''}>${esc(d.full_name)} · ${esc(d.doctor_code)}</option>`).join('')}</select></div><div class="field-group"><label>Payment date *</label><input name="paidOn" type="date" value="${todayISO()}" required></div><div class="field-group"><label>Payment method *</label><select name="paymentMethod" required><option value="Bank transfer">Bank transfer</option><option value="Cash">Cash</option><option value="Mobile payment">Mobile payment</option><option value="Other">Other</option></select></div><div class="field-group span-2"><label>Payment reference</label><input name="paymentReference" maxlength="160" placeholder="Bank transaction ID / receipt number"></div></div><div class="modal-section-label">Allocate payment</div><div id="payment-allocations" style="max-height:255px;overflow:auto">${recordRows||noRows(doctorId?'There are no outstanding commission entries for this surgeon.':'Choose a surgeon to view outstanding commission entries.','＄')}</div><div class="confirm-card"><div class="confirm-icon">＄</div><div><strong>Payment total: <span id="payment-total">$0.00</span></strong><p id="payment-selected-count">0 surgery records selected</p></div></div><div class="field-group"><label>Notes (optional)</label><textarea name="notes" maxlength="2000"></textarea></div><div id="payment-error" class="form-error hidden" style="margin-top:12px"></div><div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="button primary" type="submit">Record payment</button></div></form>`,onReady(root){const form=$('#payment-form',root);const calculate=()=>{let total=0,count=0;$$('input[name="financialIds"]',root).forEach(ch=>{const amount=$(`[name="amount-${CSS.escape(ch.value)}"]`,root);if(ch.checked){total+=Number(amount.value||0);count++;}amount.disabled=!ch.checked;});$('#payment-total',root).textContent=fmtCurrency(total);$('#payment-selected-count',root).textContent=`${count} surgery record(s) selected`;};root.addEventListener('change',e=>{if(e.target.matches('input[name="financialIds"]'))calculate();});root.addEventListener('input',e=>{if(e.target.matches('input[name^="amount-"]'))calculate();});$('#payment-doctor-id',root).addEventListener('change',()=>{const selected=$('#payment-doctor-id',root).value;closeModal();openPaymentModal(null,selected);});calculate();form.addEventListener('submit',async e=>{e.preventDefault();const formData=Object.fromEntries(new FormData(form).entries());const allocations=[];$$('input[name="financialIds"]:checked',root).forEach(ch=>allocations.push({financialId:ch.value,amount:Number($(`[name="amount-${CSS.escape(ch.value)}"]`,root).value)}));try{if(!allocations.length)throw new Error('Select at least one surgery commission.');if(state.demo){const docId=formData.doctorId;const total=allocations.reduce((n,a)=>n+a.amount,0);for(const a of allocations){const p=state.demoPayments.find(x=>x.id===a.financialId);if(!p||p.doctor_id!==docId)throw new Error('Please select financial entries for the chosen surgeon.');if(a.amount>p.outstanding+0.00001)throw new Error('An allocation exceeds the outstanding balance.');}allocations.forEach(a=>{const p=state.demoPayments.find(x=>x.id===a.financialId);p.total_paid=Number(p.total_paid)+a.amount;p.outstanding=Math.round((Number(p.commission_amount)+Number(p.adjustment_amount)-p.total_paid)*100)/100;p.payment_status=p.outstanding<=0?'Paid':p.total_paid>0?'Partially paid':'Pending';p.last_payment_date=formData.paidOn;});state.demoPaymentHistory.unshift({payment_code:`PAY-DEMO-${Date.now().toString().slice(-5)}`,doctor_id:docId,doctor_name:doctors.find(d=>(d.doctor_id||d.id)===docId)?.full_name,doctor_code:doctors.find(d=>(d.doctor_id||d.id)===docId)?.doctor_code,amount:total,payment_method:formData.paymentMethod,paid_on:formData.paidOn,payment_reference:formData.paymentReference,status:'recorded',allocations:allocations.map(a=>({bookingCode:state.demoPayments.find(p=>p.id===a.financialId)?.booking_code,amount:a.amount}))});}else await api('/api/payments',{method:'POST',body:{...formData,allocations}});closeModal();setToast('Payment recorded and allocated.');renderPage();}catch(err){const error=$('#payment-error',root);error.textContent=err.message;error.classList.remove('hidden');}});}});
}
function openReversePaymentModal(id){const p=state.paymentHistory.find(x=>x.id===id||x.payment_code===id);showModal({title:'Reverse payment record',subtitle:'Reversal is recorded in the audit trail; the original entry is retained.',small:true,body:`<div class="confirm-card"><div class="confirm-icon">!</div><div><strong>${esc(p?.payment_code||'Payment')}</strong><p>${fmtCurrency(p?.amount)} · ${esc(p?.doctor_name||'Surgeon')}</p></div></div><div class="field-group"><label>Reason for reversal *</label><textarea id="reverse-payment-reason" required minlength="5"></textarea></div>`,footer:'<button class="button secondary" data-action="close-modal">Cancel</button><button class="button danger" id="confirm-reverse-payment">Reverse payment</button>',onReady(root){$('#confirm-reverse-payment',root).addEventListener('click',async()=>{const reason=$('#reverse-payment-reason',root).value.trim();if(reason.length<5){setToast('Enter a reversal reason of at least 5 characters.','error');return;}try{if(state.demo){p.status='reversed';}else await api(`/api/payments/${id}/reverse`,{method:'POST',body:{reason}});closeModal();setToast('Payment reversed with audit trail.');renderPage();}catch(e){setToast(e.message,'error');}});}});}

function openSurgeryTypeModal(id=null){const t=id?state.meta.surgeryTypes.find(x=>x.id===id):null;showModal({title:t?'Edit surgery type':'Add surgery type',subtitle:'New default durations apply to new bookings only.',small:true,body:`<form id="type-form"><div class="field-group"><label>Surgery name *</label><input name="name" maxlength="120" required value="${esc(t?.name||'')}"></div><div class="field-group" style="margin-top:14px"><label>Default duration *</label><select name="defaultDurationMinutes">${[30,60,90,120,150,180,210,240,270,300,330,360].map(d=>`<option value="${d}" ${(t?.default_duration_minutes||30)===d?'selected':''}>${d} minutes</option>`).join('')}</select><small class="field-hint">Duration must be in 30-minute increments.</small></div>${t?`<label class="check-row" style="margin-top:15px"><input name="active" type="checkbox" ${t.active?'checked':''}> Active and available for new bookings</label>`:''}<div id="type-error" class="form-error hidden" style="margin-top:12px"></div><div style="display:flex;justify-content:flex-end;margin-top:18px"><button class="button primary" type="submit">Save surgery type</button></div></form>`,onReady(root){$('#type-form',root).addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.currentTarget),data={name:fd.get('name'),defaultDurationMinutes:Number(fd.get('defaultDurationMinutes')),active:fd.get('active')==='on'};try{if(state.demo){if(t)Object.assign(t,{name:data.name,default_duration_minutes:data.defaultDurationMinutes,active:data.active});else state.meta.surgeryTypes.push({id:`type-${Date.now()}`,name:data.name,default_duration_minutes:data.defaultDurationMinutes,active:true});}else if(t)await api(`/api/surgery-types/${id}`,{method:'PATCH',body:data});else await api('/api/surgery-types',{method:'POST',body:data});closeModal();setToast('Surgery type saved.');renderPage();}catch(err){const el=$('#type-error',root);el.textContent=err.message;el.classList.remove('hidden');}});}});}

async function changeUserStatus(userId,status){const reason=status==='active'?'':prompt('Reason for changing account status (optional):')||'';try{if(state.demo){const d=state.demoDoctors.find(x=>x.user_id===userId);if(d)d.status=status;}else await api(`/api/users/${userId}/status`,{method:'PATCH',body:{status,reason}});setToast(`Account status set to ${status}.`);}catch(e){setToast(e.message,'error');renderPage();}}
async function saveOperatingHours(){const rows=[];const enabled=new Set($$('.hours-enabled:checked').map(c=>`${c.dataset.weekday}-${c.dataset.session}`));const map=new Map();$$('.hours-input').forEach(input=>{const key=`${input.dataset.weekday}-${input.dataset.session}`;const row=map.get(key)||{weekday:Number(input.dataset.weekday),sessionName:input.dataset.session};row[input.dataset.field==='start'?'startTime':'endTime']=input.value;map.set(key,row);});for(const [key,row] of map){if(enabled.has(key))rows.push(row);}try{if(state.demo){setToast('Demo preview only — operating hours were not saved to a database.','error');return;}await api('/api/operating-hours',{method:'PUT',body:{operatingHours:rows}});setToast('Operating hours updated.');renderPage();}catch(e){setToast(e.message,'error');}}
async function deactivateBlockedPeriod(id){
  if(!isAdmin())return;
  if(!confirm('Deactivate this blocked period? The historical record will be retained.'))return;
  try{if(state.demo)throw new Error('Demo preview only — this change was not saved.');await api(`/api/blocked-periods/${id}`,{method:'DELETE'});setToast('Blocked period deactivated.');renderPage();}catch(e){setToast(e.message,'error');}
}
async function createBlockedPeriod(e){e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget).entries());const start=new Date(`${data.startsAt}:00+07:00`),end=new Date(`${data.endsAt}:00+07:00`);if(end<=start){setToast('The end time must be after the start time.','error');return;}try{if(state.demo)throw new Error('Demo preview only — this closure was not saved to a database.'); // datetime-local values are in the clinic user's local browser; convert local input to Cambodia offset below
    data.startsAt=`${data.startsAt}:00+07:00`;data.endsAt=`${data.endsAt}:00+07:00`;await api('/api/blocked-periods',{method:'POST',body:data});setToast('Blocked period created.');renderPage();}catch(err){setToast(err.message,'error');}}
function downloadCsv(type){if(state.demo){setToast('CSV export requires a connected database. Demo records are not exported.','error');return;}window.location.href=`/api/reports/${type}.csv`;}

function closeMobileNav(){$('#sidebar').classList.remove('open');$('#mobile-overlay').classList.remove('show');}
function bindGlobalUI(){
  $('#login-form').addEventListener('submit',async e=>{e.preventDefault();const form=new FormData(e.currentTarget);const error=$('#login-error');error.classList.add('hidden');const button=e.currentTarget.querySelector('button[type=submit]');button.disabled=true;button.textContent='Signing in…';try{const r=await api('/api/auth/login',{method:'POST',body:{phone:form.get('phone'),password:form.get('password')}});state.user=r.user;state.demo=false;if(r.user.passwordChangeRequired){showPasswordScreen();}else{await primeMeta();showApplication();}}catch(err){error.textContent=err.message.includes('fetch')?'The application server is not connected. Use demo preview to explore the interface.':err.message;error.classList.remove('hidden');}finally{button.disabled=false;button.innerHTML='Sign in <span aria-hidden="true">→</span>';}});
  $('#toggle-password').addEventListener('click',()=>{const p=$('#login-form input[name=password]');p.type=p.type==='password'?'text':'password';$('#toggle-password').textContent=p.type==='password'?'Show':'Hide';});
  $('#preview-button').addEventListener('click',()=>{seedDemo();state.demo=true;state.user={id:'demo-admin',fullName:'PPEC Administrator',role:'admin',doctorId:null};state.page='dashboard';state.calendarDate=todayISO();state.calendarView='week';showApplication();});
  $('#password-form').addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const error=$('#password-error');error.classList.add('hidden');if(fd.get('newPassword')!==fd.get('confirmPassword')){error.textContent='The new passwords do not match.';error.classList.remove('hidden');return;}try{await api('/api/auth/change-password',{method:'POST',body:{oldPassword:fd.get('oldPassword'),newPassword:fd.get('newPassword')}});state.user.passwordChangeRequired=false;await primeMeta();showApplication();setToast('Your password was updated.');}catch(err){error.textContent=err.message;error.classList.remove('hidden');}});
  $('#password-logout').addEventListener('click',logout);$('#sidebar-logout').addEventListener('click',logout);$('#top-user-menu').addEventListener('click',logout);
  $('#mobile-menu').addEventListener('click',()=>{$('#sidebar').classList.add('open');$('#mobile-overlay').classList.add('show');});$('#sidebar-close').addEventListener('click',closeMobileNav);$('#mobile-overlay').addEventListener('click',closeMobileNav);
}
async function primeMeta(){try{state.meta=await api('/api/meta');if(isAdmin())state.doctors=await getDoctors();}catch(e){if(!state.demo)console.warn('Unable to preload application metadata:',e.message);}}
async function logout(){try{if(!state.demo)await api('/api/auth/logout',{method:'POST'});}catch{}state.user=null;state.demo=false;state.page='dashboard';showAuth();$('#login-form').reset();$('#login-error').classList.add('hidden');}
async function init(){bindGlobalUI();updateClock();setInterval(updateClock,60000);try{const response=await api('/api/auth/me');state.user=response.user;state.demo=false;if(response.user.passwordChangeRequired)showPasswordScreen();else{await primeMeta();showApplication();}}catch{showAuth();}}
document.addEventListener('DOMContentLoaded', init);
