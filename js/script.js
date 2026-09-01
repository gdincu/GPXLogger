// --- Application State ---
let watchId = null;
let trackPoints = [];
let wakeLock = null;
let rawElevations = []; // Used for moving average smoothing
let lastPingTime = 0; // Tracks signal dropouts

// Tracking States: 'IDLE' | 'PRELOCKING' | 'TRACKING' | 'PAUSED'
let trackingState = 'IDLE'; 
let requiresNewSegment = false; // Set after resume or signal dropouts

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

function getSmoothedElevation(newEle) {
    if (newEle === null) return 0;
    rawElevations.push(newEle);
    if (rawElevations.length > 5) rawElevations.shift(); // Keep last 5 points
    const sum = rawElevations.reduce((a, b) => a + b, 0);
    return sum / rawElevations.length;
}

// --- Wake Lock Helpers ---
async function requestWakeLock() {
    if ('wakeLock' in navigator && wakeLock === null) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            console.error("Wake lock failed:", err);
        }
    }
}

function releaseWakeLock() {
    if (wakeLock !== null) {
        wakeLock.release().then(() => wakeLock = null);
    }
}

// --- Lifecycle Functions ---
window.onload = () => {
    const backup = localStorage.getItem('gpx_backup');
    if (backup) {
        const recoveredPoints = JSON.parse(backup);
        if (recoveredPoints.length > 0 && confirm(`Found ${recoveredPoints.length} unsaved points. Download them now?`)) {
            trackPoints = recoveredPoints;
            generateGPXFile();
        } else {
            localStorage.removeItem('gpx_backup');
        }
    }
};

document.addEventListener('visibilitychange', async () => {
    // Only re-acquire wake lock if we are actively tracking
    if (document.visibilityState === 'visible' && trackingState === 'TRACKING') {
        await requestWakeLock();
    }
});

// --- GPS Watch Handler ---
function handlePositionUpdate(pos) {
    const currentAccuracy = pos.coords.accuracy;
    accuracyDiv.innerText = `Current Accuracy: ±${Math.round(currentAccuracy)}m`;

    if (trackingState === 'PRELOCKING') {
        statusDiv.innerText = `Status: GPS Lock Active (±${Math.round(currentAccuracy)}m) - Ready to Start!`;
        return;
    }

    const maxAcc = parseFloat(inputMaxAccuracy.value) || 30;
    const minDist = parseFloat(inputMinDistance.value) || 5;
    const maxTimeMs = (parseFloat(inputMaxTime.value) || 60) * 1000;
    const maxSpeed = parseFloat(inputMaxSpeed.value) || 30;

    if (currentAccuracy > maxAcc) return;

    const nowMs = pos.timestamp;
    let isNewSegment = requiresNewSegment;

    if (lastPingTime > 0 && (nowMs - lastPingTime > 45000)) {
        kalmanLat.reset();
        kalmanLon.reset();
        isNewSegment = true; 
    }
    lastPingTime = nowMs;

    // --- THE FIX: Unit Conversion & Speed Gating ---
    // 1 degree of latitude is roughly 111,320 meters. We must convert accuracy to degrees for the math to work.
    const accuracyDeg = currentAccuracy / 111320;
    const nativeSpeedKmh = (pos.coords.speed || 0) * 3.6;
    
    let finalLat, finalLon;

    // If moving faster than 12 km/h (driving/fast cycling), bypass the filter to prevent corner-cutting
    if (nativeSpeedKmh > 12) {
        finalLat = pos.coords.latitude;
        finalLon = pos.coords.longitude;
        
        // Force the Kalman state to follow along so it doesn't slingshot when we eventually stop
        kalmanLat.x = finalLat;
        kalmanLon.x = finalLon;
    } else {
        // If walking or stopped, apply the fixed Kalman filter to eliminate stationary drift
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
        const calculatedSpeedKmh = (distance / (timeDiff / 1000)) * 3.6;

        if (calculatedSpeedKmh > maxSpeed) return;
        if (pos.coords.speed !== null && nativeSpeedKmh < 1.5) return; 

        const dynamicMinDist = Math.max(minDist, (lastPoint.accuracy + currentAccuracy) * 0.5);
        const movedEnough = distance >= dynamicMinDist;
        const waitedEnough = timeDiff >= maxTimeMs;

        if (!movedEnough && !waitedEnough && !isNewSegment) return; 
    }

    requiresNewSegment = false; 
    trackPoints.push(newPoint);
    statusDiv.innerText = `Status: Tracking... (${trackPoints.length} points)`;
    
    if (trackPoints.length % 10 === 0) {
        localStorage.setItem('gpx_backup', JSON.stringify(trackPoints));
    }
}

// --- Control Functions ---
function lockGps() {
    if (watchId !== null) return; // Already watching

    if (!navigator.geolocation) {
        alert("Geolocation not supported");
        return;
    }

    trackingState = 'PRELOCKING';
    statusDiv.innerText = "Status: Warming up GPS radio...";

    watchId = navigator.geolocation.watchPosition(
        handlePositionUpdate,
        (err) => alert(`GPS Error: ${err.message}`),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
}

async function startTracking() {
    if (!navigator.geolocation) {
        alert("Geolocation not supported");
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
        requiresNewSegment = false;
        kalmanLat.reset();
        kalmanLon.reset();
    }

    trackingState = 'TRACKING';
    statusDiv.innerText = "Status: Tracking...";

    if (startBtn) startBtn.disabled = true;
    if (pauseBtn) pauseBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = false;

    // Start the watch if it wasn't already started by lockGps()
    if (watchId === null) {
        watchId = navigator.geolocation.watchPosition(
            handlePositionUpdate,
            (err) => alert(`GPS Error: ${err.message}`),
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
        );
    }
}

function pauseTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }

    releaseWakeLock(); // Let screen turn off to save battery

    trackingState = 'PAUSED';
    statusDiv.innerText = "Status: Paused (GPS Radio OFF)";
    
    if (startBtn) {
        startBtn.innerText = "Resume Tracking";
        startBtn.disabled = false;
    }
    if (pauseBtn) pauseBtn.disabled = true;
}

function stopTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    
    releaseWakeLock();

    statusDiv.innerText = "Status: Generating File...";
    accuracyDiv.innerText = "";
    
    if (startBtn) {
        startBtn.innerText = "Start Tracking";
        startBtn.disabled = false;
    }
    if (pauseBtn) pauseBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = true;

    trackingState = 'IDLE';
    generateGPXFile();
}

function generateGPXFile() {
    // Save any remaining points that didn't hit the modulo 10 check
    if (trackPoints.length > 0) {
        localStorage.setItem('gpx_backup', JSON.stringify(trackPoints));
    }

    if (trackPoints.length === 0) {
        alert("No accurate points were logged.");
        statusDiv.innerText = "Status: Idle";
        return;
    }

    const header = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="WebGPX"><trk><trkseg>\n`;
    
    // Build GPX, mapping altitude to 1 decimal place and splitting segments on dropouts
    const body = trackPoints.map((p, index) => {
        let ptXml = `  <trkpt lat="${p.lat}" lon="${p.lon}">\n    <ele>${p.ele.toFixed(1)}</ele>\n    <time>${p.time}</time>\n  </trkpt>`;
        
        // Break GPX line on tunnel reconnections/dropouts or pauses
        if (p.isNewSegment && index > 0) {
            return `</trkseg>\n<trkseg>\n` + ptXml;
        }
        return ptXml;
    }).join('\n');
    
    const footer = `\n</trkseg></trk></gpx>`;
    
    const finalGpx = header + body + footer;

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([finalGpx], {type: 'application/gpx+xml'}));
    a.download = `track_${new Date().toISOString().slice(0,10)}.gpx`;
    a.click();
    
    localStorage.removeItem('gpx_backup');
    trackPoints = [];
    rawElevations = [];
    
    statusDiv.innerText = "Status: Downloaded!";
}

function applyPresets(accuracy, distance, time, speed, processNoise) {
    inputMaxAccuracy.value = accuracy;
    inputMinDistance.value = distance;
    inputMaxTime.value = time;
    inputMaxSpeed.value = speed;

    // Dynamically adjust how aggressively the filter smooths
    kalmanLat.setProcessNoise(processNoise);
    kalmanLon.setProcessNoise(processNoise);
}

// Screen Lock Logic / Unlock Logic
const lockScreenBtn = document.getElementById('lockScreenBtn');
const touchLockOverlay = document.getElementById('touchLockOverlay');
const unlockSlider = document.getElementById('unlockSlider');

if (lockScreenBtn && touchLockOverlay && unlockSlider) {
    lockScreenBtn.addEventListener('click', () => {
        touchLockOverlay.style.display = 'flex';
        unlockSlider.value = 0; // Reset slider position
    });

    // Continuously check the slider value as the user drags it
    unlockSlider.addEventListener('input', (e) => {
        if (e.target.value >= 95) { // If dragged 95% of the way to the right
            touchLockOverlay.style.display = 'none'; // Hide overlay
            e.target.value = 0; // Reset for next time
        }
    });

    unlockSlider.addEventListener('change', (e) => {
        if (e.target.value < 95) {
            e.target.value = 0;
        }
    });
}

// --- Event Listeners ---
if (lockGpsBtn) lockGpsBtn.addEventListener('click', lockGps);
if (startBtn) startBtn.addEventListener('click', startTracking);
if (pauseBtn) pauseBtn.addEventListener('click', pauseTracking);
if (stopBtn) stopBtn.addEventListener('click', stopTracking);

// Walk: Erratic movement, quick turns. (q = 0.001)
if (btnWalk) btnWalk.addEventListener('click', () => applyPresets(30, 5, 60, 15, 0.001));
// Bike: Faster, smoother curves. (q = 0.0005)
if (btnBike) btnBike.addEventListener('click', () => applyPresets(40, 15, 60, 90, 0.0005));
// Drive: Filter largely bypassed by speed gate, but fallback value included.
if (btnDrive) btnDrive.addEventListener('click', () => applyPresets(50, 50, 120, 180, 0.0001));

window.addEventListener('beforeunload', (e) => {
    if (watchId !== null) {
        e.preventDefault();
        e.returnValue = ''; // Standard for modern browsers to trigger the confirmation dialog
    }
});

// --- Service Worker Registration (for PWA / Offline support) ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(registration => {
                console.log('ServiceWorker registration successful with scope: ', registration.scope);
            })
            .catch(err => {
                console.error('ServiceWorker registration failed: ', err);
            });
    });
}