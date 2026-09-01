// --- Application State ---
let watchId = null;
let trackPoints = [];
let wakeLock = null;
let rawElevations = []; // Used for moving average smoothing
let lastPingTime = 0; // Tracks signal dropouts

// --- DOM Elements ---
const startBtn = document.getElementById('startBtn');
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
    if (document.visibilityState === 'visible' && watchId !== null) {
        if ('wakeLock' in navigator && wakeLock === null) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
            } catch (err) {
                console.error(`Wake lock re-acquire failed: ${err.message}`);
            }
        }
    }
});

async function startTracking() {
    if (!navigator.geolocation) {
        alert("Geolocation not supported");
        return;
    }

    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            console.error("Initial wake lock failed:", err);
        }
    }

    trackPoints = [];
    rawElevations = [];
    lastPingTime = 0;
    kalmanLat.reset();
    kalmanLon.reset();

    statusDiv.innerText = "Status: Acquiring GPS lock...";
    startBtn.disabled = true;
    stopBtn.disabled = false;

    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const currentAccuracy = pos.coords.accuracy;
            accuracyDiv.innerText = `Current Accuracy: ±${Math.round(currentAccuracy)}m`;

            // 1. Read user thresholds
            const maxAcc = parseFloat(inputMaxAccuracy.value) || 30;
            const minDist = parseFloat(inputMinDistance.value) || 5;
            const maxTimeMs = (parseFloat(inputMaxTime.value) || 60) * 1000;
            const maxSpeed = parseFloat(inputMaxSpeed.value) || 30;

            // 2. Hard Accuracy Filter
            if (currentAccuracy > maxAcc) return;

            const nowMs = pos.timestamp;
            let isNewSegment = false;

            // 3. Tunnel / Dropout Detection (> 45 seconds gap)
            if (lastPingTime > 0 && (nowMs - lastPingTime > 45000)) {
                kalmanLat.reset();
                kalmanLon.reset();
                isNewSegment = true; 
            }
            lastPingTime = nowMs;

            // 4. Apply Kalman Filter to Lat/Lon
            const filteredLat = kalmanLat.filter(pos.coords.latitude, currentAccuracy);
            const filteredLon = kalmanLon.filter(pos.coords.longitude, currentAccuracy);

            const now = new Date(pos.timestamp);
            const smoothedEle = getSmoothedElevation(pos.coords.altitude);
            
            // Native Doppler Speed in km/h (fallback to 0 if null)
            const nativeSpeedKmh = (pos.coords.speed || 0) * 3.6;

            const newPoint = {
                lat: filteredLat,
                lon: filteredLon,
                ele: smoothedEle,
                time: now.toISOString(),
                timestamp: pos.timestamp, 
                accuracy: currentAccuracy,
                isNewSegment: isNewSegment
            };

            if (trackPoints.length > 0) {
                const lastPoint = trackPoints[trackPoints.length - 1];
                
                // Calculate distance using the FILTERED coordinates
                const distance = getDistance(lastPoint.lat, lastPoint.lon, newPoint.lat, newPoint.lon);
                const timeDiff = newPoint.timestamp - lastPoint.timestamp;
                
                const calculatedSpeedKmh = (distance / (timeDiff / 1000)) * 3.6;

                // 5. Speed Sanity Check (Drop obvious glitches)
                if (calculatedSpeedKmh > maxSpeed) return;

                // 6. Stationary Drift Filter
                if (pos.coords.speed !== null && nativeSpeedKmh < 1.5) {
                    return; // Ignored: Native GPS indicates stationary
                }

                // 7. Signal-to-Noise Ratio & Distance/Time Filter
                const dynamicMinDist = Math.max(minDist, (lastPoint.accuracy + currentAccuracy) * 0.5);
                const movedEnough = distance >= dynamicMinDist;
                const waitedEnough = timeDiff >= maxTimeMs;

                if (!movedEnough && !waitedEnough && !isNewSegment) {
                    return; // Ignored: Didn't move enough outside accuracy radius
                }
            }

            // Passed all filters - log the point
            trackPoints.push(newPoint);
            statusDiv.innerText = `Status: Tracking... (${trackPoints.length} points)`;
            localStorage.setItem('gpx_backup', JSON.stringify(trackPoints));
        },
        (err) => alert(`Error: ${err.message}`),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
}

function stopTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    
    if (wakeLock !== null) wakeLock.release().then(() => wakeLock = null);

    statusDiv.innerText = "Status: Generating File...";
    accuracyDiv.innerText = "";
    startBtn.disabled = false;
    stopBtn.disabled = true;

    generateGPXFile();
}

function generateGPXFile() {
    if (trackPoints.length === 0) {
        alert("No accurate points were logged.");
        statusDiv.innerText = "Status: Idle";
        return;
    }

    const header = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="WebGPX"><trk><trkseg>\n`;
    
    // Build GPX, mapping altitude to 1 decimal place and splitting segments on dropouts
    const body = trackPoints.map((p, index) => {
        let ptXml = `  <trkpt lat="${p.lat}" lon="${p.lon}">\n    <ele>${p.ele.toFixed(1)}</ele>\n    <time>${p.time}</time>\n  </trkpt>`;
        
        // Break GPX line on tunnel reconnections/dropouts
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
if (startBtn) startBtn.addEventListener('click', startTracking);
if (stopBtn) stopBtn.addEventListener('click', stopTracking);

// Walk: Erratic movement, quick turns. (q = 0.001)
if (btnWalk) btnWalk.addEventListener('click', () => applyPresets(30, 3, 60, 15, 0.001));
// Bike: Faster, smoother curves, less erratic. (q = 0.0001)
if (btnBike) btnBike.addEventListener('click', () => applyPresets(40, 15, 60, 90, 0.0001));
// Drive: High speed, straight lines, highly predictable. (q = 0.00001)
if (btnDrive) btnDrive.addEventListener('click', () => applyPresets(50, 50, 120, 180, 0.00001));

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