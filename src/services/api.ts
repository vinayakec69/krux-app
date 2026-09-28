import { auth, db, rtdb } from '../firebase';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import {
  doc, getDoc, setDoc, updateDoc, collection,
  query, where, orderBy, limit, getDocs,
  onSnapshot, increment, serverTimestamp, addDoc
} from 'firebase/firestore';
import { ref, onValue, off, set } from 'firebase/database';

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────

export async function signupUser(name: string, email: string, password: string, location: string) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;
  // Create profile document in Firestore
  await setDoc(doc(db, 'profiles', uid), {
    name,
    email,
    location,
    avatar: '🌱',
    krux_balance: 50,
    green_score: 0,
    streak: 0,
    last_scan_date: null,
    total_scans: 0,
    co2_saved: 0,
    water_saved: 0,
    plastic_recycled: 0,
    xp: 0,
    level: 1,
    badges: [],
    streak_freezes: 0,
    challenge_progress: {},
    daily_scan_count: 0,
    referral_code: uid.slice(0, 8).toUpperCase(),
    created_at: serverTimestamp(),
  });
  return cred.user;
}

export async function loginUser(email: string, password: string) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function logoutUser() {
  await signOut(auth);
}

export function onAuthChange(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}

// ─────────────────────────────────────────────
// PROFILE
// ─────────────────────────────────────────────

export async function getProfile(uid: string) {
  const snap = await getDoc(doc(db, 'profiles', uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function listenProfile(uid: string, callback: (data: any) => void) {
  return onSnapshot(doc(db, 'profiles', uid), (snap) => {
    if (snap.exists()) callback({ id: snap.id, ...snap.data() });
  });
}

// ─────────────────────────────────────────────
// HANDSHAKE — Step 1
// ─────────────────────────────────────────────

export function initiateHandshake(user_id: string, bin_id: string) {
  const sessionId = `session_${Date.now()}`;
  const binRef = ref(rtdb, `bins/${bin_id}`);

  console.log(`[Handshake] Initiating handshake for bin: ${bin_id} with user: ${user_id}`);

  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error("[Handshake] Timeout! 15 seconds elapsed without connection.");
      off(binRef);
      reject(new Error("Bin didn't respond. Is it turned on and connected to Wi-Fi?"));
    }, 15000);

    onValue(binRef, (snapshot) => {
      const data = snapshot.val();
      console.log("[Handshake] Received update from DB:", data);
      
      if (data && data.status === 'connected' && data.session_id === sessionId) {
        console.log("[Handshake] SUCCESS! Bin is connected.");
        clearTimeout(timeout);
        off(binRef);
        resolve({ valid: true, session_id: sessionId });
      } else if (data && data.status === 'connected') {
        console.log("[Handshake] Ignoring old 'connected' state, waiting for new handshake.");
      }
    });

    console.log("[Handshake] Writing 'requesting_connection' to DB...");
    set(binRef, {
      status: 'requesting_connection',
      user_id: user_id,
      session_id: sessionId,
      timestamp: Date.now()
    }).then(() => {
      console.log("[Handshake] Successfully wrote request to DB. Waiting for ESP32...");
    }).catch(err => {
      console.error("[Handshake] Failed to write to DB!", err);
      clearTimeout(timeout);
      reject(new Error("Network error: Could not reach Firebase."));
    });
  });
}

// ─────────────────────────────────────────────
// SCAN VALIDATE — Step 2 & 3
// Writes the ML classification to Firebase RTDB
// so the ESP32 knows what material was detected
// ─────────────────────────────────────────────

export async function validateScan(payload: {
  session_id: string;
  predicted_class: string;
  confidence: number;
  image_hash: string;
  perceptual_hash: string;
  bin_id?: string;
  gps?: { lat: number; lng: number };
}) {
  const COINS_MAP: Record<string, number> = {
    PET: 15, HDPE: 12, PP: 11, LDPE: 10, PVC: 8, PS: 7, OTHER: 5
  };
  const coins = COINS_MAP[payload.predicted_class] || 10;

  // Write the classification command to RTDB for the ESP32 to read
  if (payload.bin_id) {
    const cmdRef = ref(rtdb, `scan_commands/${payload.bin_id}`);
    await set(cmdRef, {
      material: payload.predicted_class,
      confidence: payload.confidence,
      coins: coins,
      session_id: payload.session_id,
      timestamp: Date.now(),
      status: 'pending_drop'  // ESP32 will change to 'actuating' then 'dropped'
    });
    console.log(`[ValidateScan] Wrote classification to /scan_commands/${payload.bin_id}:`, payload.predicted_class);
  }

  return {
    valid: true,
    krux_earned: coins
  };
}

// ─────────────────────────────────────────────
// REALTIME LISTENER — Step 6
// Call this after scan to wait for bin confirmation
// ─────────────────────────────────────────────

export function listenForDropConfirmation(
  bin_id: string,
  onConfirmed: (data: any) => void,
  timeoutMs = 120000
) {
  const rtdbRef = ref(rtdb, `drop_events/${bin_id}`);
  let timeoutId: ReturnType<typeof setTimeout>;
  let isFirstRead = true;

  // Clear any stale drop_events BEFORE listening
  set(rtdbRef, null).then(() => {
    console.log('[DropListener] Cleared stale drop_events. Waiting for fresh confirmation...');
  });

  const unsubscribe = onValue(rtdbRef, (snap) => {
    // Skip the first read (which is our own null-clear)
    if (isFirstRead) { isFirstRead = false; return; }

    if (snap.exists() && snap.val()?.status === 'confirmed') {
      console.log('[DropListener] Drop confirmed by ESP32!', snap.val());
      clearTimeout(timeoutId);
      off(rtdbRef);
      onConfirmed(snap.val());
    }
  });

  timeoutId = setTimeout(() => {
    off(rtdbRef);
  }, timeoutMs);

  return () => { clearTimeout(timeoutId); off(rtdbRef); };
}

// ─────────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────────

export async function getLeaderboard(limitCount = 20) {
  const q = query(
    collection(db, 'profiles'),
    orderBy('green_score', 'desc'),
    limit(limitCount)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─────────────────────────────────────────────
// LEDGER HISTORY
// ─────────────────────────────────────────────

export async function getLedger(uid: string, limitCount = 20) {
  const q = query(
    collection(db, 'profiles', uid, 'ledger'),
    orderBy('created_at', 'desc'),
    limit(limitCount)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
