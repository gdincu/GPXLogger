// --- Constants ---
const GEO_HIGH_ACCURACY = { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 };
const GEO_FALLBACK = { enableHighAccuracy: false, maximumAge: 0, timeout: 30000 };
const SIGNAL_DROPOUT_MS = 45000; // New trkseg after this gap (tunnels)
const KALMAN_BYPASS_KMH = 12; // Above this, raw GPS hugs curves (no smoothing)
const STATIONARY_FREEZE_KMH = 1.5; // Below this, freeze logging (Doppler drift fix)
const FALLBACK_MAX_ACCURACY_M = 500; // Relaxed filter when on cell/Wi-Fi fallback
const UNLOCK_THRESHOLD = 95;
const ELE_SMOOTHING_WINDOW = 5;
const BACKUP_EVERY_N = 10;
const METERS_PER_DEGREE_LAT = 111320;
const BACKUP_KEY = 'gpx_backup';

// --- Application State ---
let watchId = null;
let trackPoints = [];
let wakeLock = null;
let rawElevations = []; // Used for moving average smoothing
let lastPingTime = 0; // Tracks signal dropouts
let isScreenLocked = false;
let kalmanMultiplier = 0.1; // Default (bike); changed by presets

// Tracking States: 'IDLE' | 'PRELOCKING' | 'TRACKING' | 'PAUSED'
let trackingState = 'IDLE'; 
let requiresNewSegment = false; // Set after resume or signal dropouts
let isUsingFallback = false;

// --- DOM Elements ---
const lockGpsBtn = document.getElementById('lockGpsBtn');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const accuracyDiv = document.getElementById('accuracy');

const inputMaxAccuracy = document.getElementById('set-accuracy');
const inputMinDistance = document.getElementById('set-distance');
const inputMaxTime = document.getElementById('set-time');
const inputMaxSpeed = document.getElementById('set-speed');

const btnWalk = document.getElementById('btn-walk');
const btnBike = document.getElementById('btn-bike');
const btnDrive = document.getElementById('btn-drive');

// --- UI helpers (single place for status/button changes) ---
function setStatus(text) {
    if (statusDiv) statusDiv.innerText = text;
}

function setAccuracyText(text) {
    if (accuracyDiv && !isScreenLocked) accuracyDiv.innerText = text;
}

function updateControlState() {
    const watching = watchId !== null;
    const tracking = trackingState === 'TRACKING';
    const paused = trackingState === 'PAUSED';
    if (lockGpsBtn) lockGpsBtn.disabled = watching || tracking;
    if (startBtn) startBtn.disabled = tracking;
    if (pauseBtn) pauseBtn.disabled = !tracking;
    if (stopBtn) stopBtn.disabled = !(tracking || (paused && trackPoints.length > 0));
}

function resetControlsToIdle(statusText) {
    trackingState = 'IDLE';
    if (startBtn) {
        startBtn.innerText = 'Start Tracking';
        startBtn.disabled = false;
    }
    if (pauseBtn) pauseBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = true;
    if (lockGpsBtn) lockGpsBtn.disabled = watchId !== null;
    if (statusText) setStatus(statusText);
}

// --- Helper Classes & Functions ---
class SimpleKalman {
    constructor(processNoise = 0.001) {
        this.q = processNoise; // Predictability of movement
        this.x = null; // State estimate
        this.p = null; // Estimate error
    }

    setProcessNoise(newQ) {
        this.q = newQ;
    }

    reset() {
        this.x = null;
        this.p = null;
    }

    filter(measurement, accuracy) {
        if (this.x === null) {
            this.x = measurement;
            this.p = accuracy;
            return this.x;
        }
        // Prediction
        this.p = this.p + this.q;
        
        // Update
        const k = this.p / (this.p + accuracy); // Kalman gain
        this.x = this.x + k * (measurement - this.x);
        this.p = (1 - k) * this.p;
        
        return this.x;
    }
}

const kalmanLat = new SimpleKalman();
const kalmanLon = new SimpleKalman();

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function stopWatch() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
}

function handleGpsError(err) {
    // Error code 3 corresponds to TIMEOUT
    if (err.code === 3) {
        console.warn('High-accuracy GPS timed out. Falling back to lower accuracy.');
        setStatus('Status: GPS timeout. Retrying with standard accuracy');
        
        // Clear the failed high-accuracy watch
        stopWatch();
		
		isUsingFallback = true;

        // Retry with high accuracy disabled (allows Wi-Fi/cell triangulation)
        watchId = navigator.geolocation.watchPosition(
            handlePositionUpdate,
            (fallbackErr) => {
                setStatus(`Status: GPS Error (${fallbackErr.message})`);
            },
            GEO_FALLBACK
        );
        updateControlState();
    } else if (err.code === 1) {
        // PERMISSION_DENIED: stuck UI is worse than an error, so reset.
        stopWatch();
        releaseWakeLock();
        resetControlsToIdle(`Status: GPS permission denied`);
    } else {
        // POSITION_UNAVAILABLE etc: non-blocking, keep watching for recovery.
        setStatus(`Status: GPS Error (${err.message})`);
    }
}

function getSmoothedElevation(newEle) {
    if (newEle === null || newEle === undefined || !Number.isFinite(newEle)) {
        if (rawElevations.length === 0) return 0;
        const sum = rawElevations.reduce((a, b) => a + b, 0);
        return sum / rawElevations.length;
    }
    rawElevations.push(newEle);
    if (rawElevations.length > ELE_SMOOTHING_WINDOW) rawElevations.shift(); // Keep last N points
    const sum = rawElevations.reduce((a, b) => a + b, 0);
    return sum / rawElevations.length;
}

function saveBackup() {
    try {
        localStorage.setItem(BACKUP_KEY, JSON.stringify(trackPoints));
    } catch (err) {
        console.warn('Could not save backup (quota?):', err);
    }
}

// --- Wake Lock Helpers ---
async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (wakeLock !== null) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
        });
    } catch (err) {
        console.error('Wake lock failed:', err);
        wakeLock = null;
    }
}

function releaseWakeLock() {
    if (wakeLock !== null) {
        const lock = wakeLock;
        wakeLock = null;
        lock.release().catch((err) => console.warn('Wake lock release failed:', err));
    }
}

// --- Lifecycle Functions ---
window.addEventListener('load', () => {
    let backup = null;
    try {
        backup = localStorage.getItem(BACKUP_KEY);
    } catch (err) {
        console.warn('Could not read backup:', err);
        return;
    }
    if (!backup) return;
    let recoveredPoints = null;
    try {
        recoveredPoints = JSON.parse(backup);
    } catch (err) {
        console.warn('Corrupt backup, discarding:', err);
        try { localStorage.removeItem(BACKUP_KEY); } catch { /* ignore */ }
        return;
    }
    if (!Array.isArray(recoveredPoints) || recoveredPoints.length === 0) {
        try { localStorage.removeItem(BACKUP_KEY); } catch { /* ignore */ }
        return;
    }
    if (confirm(`Found ${recoveredPoints.length} unsaved points. Download them now?`)) {
        trackPoints = recoveredPoints;
        generateGPXFile();
    }
    // If declined: keep the backup so no data is lost. It will prompt again next load.
});

document.addEventListener('visibilitychange', async () => {
    // Only re-acquire wake lock if we are actively tracking
    if (document.visibilityState === 'visible' && trackingState === 'TRACKING') {
        await requestWakeLock();
    }
});

// --- GPS Watch Handler ---
function handlePositionUpdate(pos) {
    const currentAccuracy = pos.coords.accuracy;
	
    setAccuracyText(`Current Accuracy: ±${Math.round(currentAccuracy)}m`);

    if (trackingState === 'PRELOCKING') {
        setStatus(`Status: GPS Ready (±${Math.round(currentAccuracy)}m)`);
        return;
    }

    if (trackingState !== 'TRACKING') return;

    const maxAcc = isUsingFallback ? FALLBACK_MAX_ACCURACY_M : (parseFloat(inputMaxAccuracy.value) || 30);
    const minDist = parseFloat(inputMinDistance.value) || 5;
    const maxTimeMs = (parseFloat(inputMaxTime.value) || 60) * 1000;
    const maxSpeed = parseFloat(inputMaxSpeed.value) || 100;

    if (currentAccuracy > maxAcc) return;

    const nowMs = pos.timestamp;
    let isNewSegment = requiresNewSegment;

    if (lastPingTime > 0 && (nowMs - lastPingTime > SIGNAL_DROPOUT_MS)) {
        kalmanLat.reset();
        kalmanLon.reset();
        isNewSegment = true; 
    }
    lastPingTime = nowMs;

    // 1 degree of latitude is roughly 111,320 meters. Convert accuracy to degrees for the filter.
    const accuracyDeg = currentAccuracy / METERS_PER_DEGREE_LAT;
    const nativeSpeedKmh = (pos.coords.speed || 0) * 3.6;
    
    let finalLat, finalLon;

    // If moving fast (driving/fast cycling), bypass the filter to prevent corner-cutting
    if (nativeSpeedKmh > KALMAN_BYPASS_KMH) {
        finalLat = pos.coords.latitude;
        finalLon = pos.coords.longitude;
        
        // Force the Kalman state to follow along so it doesn't slingshot when we eventually stop
        kalmanLat.x = finalLat;
        kalmanLon.x = finalLon;
    } else {
        // If walking or stopped, apply dynamic Kalman filter based on current accuracy
        const dynamicQ = accuracyDeg * kalmanMultiplier;
        kalmanLat.setProcessNoise(dynamicQ);
        kalmanLon.setProcessNoise(dynamicQ);

        finalLat = kalmanLat.filter(pos.coords.latitude, accuracyDeg);
        finalLon = kalmanLon.filter(pos.coords.longitude, accuracyDeg);
    }

    const now = new Date(pos.timestamp);
    const smoothedEle = getSmoothedElevation(pos.coords.altitude);

    const newPoint = {
        lat: finalLat,
        lon: finalLon,
        ele: smoothedEle,
        time: now.toISOString(),
        timestamp: pos.timestamp, 
        accuracy: currentAccuracy,
        isNewSegment: isNewSegment
    };

    if (trackPoints.length > 0) {
        const lastPoint = trackPoints[trackPoints.length - 1];
        const distance = getDistance(lastPoint.lat, lastPoint.lon, newPoint.lat, newPoint.lon);
        const timeDiff = newPoint.timestamp - lastPoint.timestamp;
        if (!Number.isFinite(timeDiff) || timeDiff <= 0) return;
        const calculatedSpeedKmh = (distance / (timeDiff / 1000)) * 3.6;

        if (calculatedSpeedKmh > maxSpeed) return;
        // Freeze when standing still. Fall back to calculated speed when the
        // device reports no native Doppler speed (null), for consistent behavior.
        const hasNativeSpeed = pos.coords.speed !== null && pos.coords.speed !== undefined;
        const effectiveStoppedSpeed = hasNativeSpeed ? nativeSpeedKmh : calculatedSpeedKmh;
        if (effectiveStoppedSpeed < STATIONARY_FREEZE_KMH) return; 

        const dynamicMinDist = Math.max(minDist, (lastPoint.accuracy + currentAccuracy) * 0.5);
        const movedEnough = distance >= dynamicMinDist;
        const waitedEnough = timeDiff >= maxTimeMs;

        if (!movedEnough && !waitedEnough && !isNewSegment) return; 
    }

    requiresNewSegment = false; 
    trackPoints.push(newPoint);
	if (!isScreenLocked) {
        setStatus(`Status: Tracking (${trackPoints.length} points)`);
	}
    
    if (trackPoints.length % BACKUP_EVERY_N === 0) {
        saveBackup();
    }
}

// --- Control Functions ---
function lockGps() {
    if (watchId !== null) return; // Already watching

    if (!navigator.geolocation) {
        setStatus('Status: Geolocation not supported');
        return;
    }

    trackingState = 'PRELOCKING';
    setStatus('Status: Acquiring GPS signal');

    watchId = navigator.geolocation.watchPosition(
        handlePositionUpdate,
        handleGpsError,
        GEO_HIGH_ACCURACY
    );
    updateControlState();
}

async function startTracking() {
    if (!navigator.geolocation) {
        setStatus('Status: Geolocation not supported');
        return;
    }

    await requestWakeLock();

    if (trackingState === 'PAUSED') {
        requiresNewSegment = true; // Break the line from the pause location
        kalmanLat.reset();
        kalmanLon.reset();
    } else {
        // Fresh start
        trackPoints = [];
        rawElevations = [];
        lastPingTime = 0;
		isUsingFallback = false;
        requiresNewSegment = false;
        kalmanLat.reset();
        kalmanLon.reset();
    }

    trackingState = 'TRACKING';
    setStatus('Status: Tracking');

    // Start the watch if it wasn't already started by lockGps()
    if (watchId === null) {
        watchId = navigator.geolocation.watchPosition(
            handlePositionUpdate,
            handleGpsError,
            GEO_HIGH_ACCURACY
        );
    }
    updateControlState();
}

function pauseTracking() {
    stopWatch();

    releaseWakeLock(); // Let screen turn off to save battery

    trackingState = 'PAUSED';
    setStatus('Status: Paused');
    
    if (startBtn) {
        startBtn.innerText = 'Resume Tracking';
        startBtn.disabled = false;
    }
    updateControlState();
    if (startBtn) startBtn.disabled = false; // Resume must stay enabled
}

function stopTracking() {
    stopWatch();
    
    releaseWakeLock();

    setStatus('Status: Generating File');
    if (accuracyDiv) accuracyDiv.innerText = '';
    
    if (startBtn) {
        startBtn.innerText = 'Start Tracking';
        startBtn.disabled = false;
    }
    if (pauseBtn) pauseBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = true;

    trackingState = 'IDLE';
    generateGPXFile();
    updateControlState();
    if (startBtn) {
        startBtn.innerText = 'Start Tracking';
        startBtn.disabled = false;
    }
}

function generateGPXFile() {
    if (trackPoints.length === 0) {
        setStatus('Status: Idle');
        return;
    }

    const nowIso = new Date().toISOString();
    const header = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GPXLogger" xmlns="http://www.topografix.com/GPX/1/1">\n<trk>\n<name>Track ${nowIso.slice(0, 10)}</name>\n<time>${nowIso}</time>\n<trkseg>\n`;
    
    // Build GPX, mapping altitude to 1 decimal place and splitting segments on dropouts
    const body = trackPoints.map((p, index) => {
        const ele = Number.isFinite(p.ele) ? p.ele.toFixed(1) : '0.0';
        let ptXml = `  <trkpt lat="${p.lat}" lon="${p.lon}">\n    <ele>${ele}</ele>\n    <time>${p.time}</time>\n  </trkpt>`;
        
        // Break GPX line on tunnel reconnections/dropouts or pauses
        if (p.isNewSegment && index > 0) {
            return `</trkseg>\n<trkseg>\n` + ptXml;
        }
        return ptXml;
    }).join('\n');
    
    const footer = `\n</trkseg>\n</trk>\n</gpx>`;
    
    const finalGpx = header + body + footer;

    const blob = new Blob([finalGpx], {type: 'application/gpx+xml'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `track_${nowIso.slice(0,10)}.gpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    
    try { localStorage.removeItem(BACKUP_KEY); } catch { /* ignore */ }
    trackPoints = [];
    rawElevations = [];
    
    setStatus('Status: Downloaded!');
}

function applyPresets(accuracy, distance, time, speed, smoothingMultiplier) {
    inputMaxAccuracy.value = accuracy;
    inputMinDistance.value = distance;
    inputMaxTime.value = time;
    inputMaxSpeed.value = speed;
    kalmanMultiplier = smoothingMultiplier;
}

// Screen Lock Logic / Unlock Logic
const lockScreenBtn = document.getElementById('lockScreenBtn');
const touchLockOverlay = document.getElementById('touchLockOverlay');
const unlockSlider = document.getElementById('unlockSlider');

if (lockScreenBtn && touchLockOverlay && unlockSlider) {
    lockScreenBtn.addEventListener('click', async () => {
        // Keep the CPU awake while the OLED-black overlay is shown.
        await requestWakeLock();
        touchLockOverlay.style.display = 'flex';
        unlockSlider.value = 0; // Reset slider position
		isScreenLocked = true;
    });

    // Continuously check the slider value as the user drags it
    unlockSlider.addEventListener('input', (e) => {
        if (Number(e.target.value) >= UNLOCK_THRESHOLD) { 
            touchLockOverlay.style.display = 'none'; 
            e.target.value = 0; 
            isScreenLocked = false; // RESUME DOM UPDATES
            
            // Immediately update UI upon unlocking so it isn't blank/stale
            if (trackingState === 'TRACKING') {
                setStatus(`Status: Tracking (${trackPoints.length} points)`);
            }
        }
    });

    unlockSlider.addEventListener('change', (e) => {
        if (Number(e.target.value) < UNLOCK_THRESHOLD) {
            e.target.value = 0;
        }
    });

    // Only suppress the long-press menu on the lock overlay itself.
    touchLockOverlay.addEventListener('contextmenu', (event) => {
        event.preventDefault();
    });
}

// --- Event Listeners ---
if (lockGpsBtn) lockGpsBtn.addEventListener('click', lockGps);
if (startBtn) startBtn.addEventListener('click', startTracking);
if (pauseBtn) pauseBtn.addEventListener('click', pauseTracking);
if (stopBtn) stopBtn.addEventListener('click', stopTracking);

// Walk: Erratic movement, slower. High smoothing needed. (multiplier = 0.02)
if (btnWalk) btnWalk.addEventListener('click', () => applyPresets(30, 5, 60, 15, 0.02));

// Bike: Faster, smoother curves. Moderate smoothing. (multiplier = 0.10)
if (btnBike) btnBike.addEventListener('click', () => applyPresets(40, 5, 60, 90, 0.10));

// Drive: Mostly bypassed by the speed gate anyway, but scaled properly. (multiplier = 0.50)
if (btnDrive) btnDrive.addEventListener('click', () => applyPresets(50, 15, 120, 180, 0.50));


window.addEventListener('beforeunload', (e) => {
    if (trackingState === 'TRACKING' && trackPoints.length > 0) {
        e.preventDefault();
        e.returnValue = ''; // Standard for modern browsers to trigger the confirmation dialog
    }
});

// --- Service Worker Registration (for PWA / Offline support) ---
if ('serviceWorker' in navigator) {
    let newWorker;
    const updateBanner = document.getElementById('updateBanner');
    const updateBtn = document.getElementById('updateBtn');

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => {
                // Check for updates whenever the page loads
                reg.addEventListener('updatefound', () => {
                    newWorker = reg.installing;
                    newWorker.addEventListener('statechange', () => {
                        // If the new worker is ready AND an old worker exists, show the prompt
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            if (updateBanner) {
                                updateBanner.hidden = false;
                                updateBanner.style.display = 'block';
                            }
                        }
                    });
                });
            })
            .catch(err => console.error('ServiceWorker registration failed: ', err));

        // When the user clicks update, tell the waiting Service Worker to take over
        if (updateBtn) {
            updateBtn.addEventListener('click', () => {
                if (newWorker) {
                    newWorker.postMessage('SKIP_WAITING');
                }
            });
        }

        // Listen for the controlling Service Worker to change, then reload the page
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) {
                window.location.reload();
                refreshing = true;
            }
        });
    });
}
