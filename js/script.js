// --- Application State ---
let watchId = null;
let trackPoints = [];
let wakeLock = null;
let rawElevations = []; // Used for moving average smoothing

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

// --- Helper Functions ---
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

            // 2. Accuracy Filter
            if (currentAccuracy > maxAcc) return;

            const now = new Date(pos.timestamp);
            const rawEle = pos.coords.altitude;
            const smoothedEle = getSmoothedElevation(rawEle);

            const newPoint = {
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                ele: smoothedEle,
                time: now.toISOString(),
                timestamp: pos.timestamp // stored for speed/time math
            };

            if (trackPoints.length > 0) {
                const lastPoint = trackPoints[trackPoints.length - 1];
                const distance = getDistance(lastPoint.lat, lastPoint.lon, newPoint.lat, newPoint.lon);
                const timeDiff = newPoint.timestamp - lastPoint.timestamp;
                
                const speedMs = distance / (timeDiff / 1000); // meters per second
                const speedKmh = speedMs * 3.6; // Convert to km/h

                // 3. Speed Sanity Check (Drop obvious glitches)
                if (speedKmh > maxSpeed) return;

                // 4. Distance & Time Based Logging
                const movedEnough = distance >= minDist;
                const waitedEnough = timeDiff >= maxTimeMs;

                if (!movedEnough && !waitedEnough) {
                    return; // Ignore this point
                }
            }

            // If it passes all tests, log it
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
    
    // Build GPX, mapping altitude to 1 decimal place
    const body = trackPoints.map(p => 
        `  <trkpt lat="${p.lat}" lon="${p.lon}">\n    <ele>${p.ele.toFixed(1)}</ele>\n    <time>${p.time}</time>\n  </trkpt>`
    ).join('\n');
    
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

function applyPresets(accuracy, distance, time, speed) {
    inputMaxAccuracy.value = accuracy;
    inputMinDistance.value = distance;
    inputMaxTime.value = time;
    inputMaxSpeed.value = speed;
}

// Screen Lock Logic / Unlock Logic
const lockScreenBtn = document.getElementById('lockScreenBtn');
const touchLockOverlay = document.getElementById('touchLockOverlay');
const unlockSlider = document.getElementById('unlockSlider');

												   
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

// --- Event Listeners ---
startBtn.addEventListener('click', startTracking);
stopBtn.addEventListener('click', stopTracking);
btnWalk.addEventListener('click', () => applyPresets(30, 3, 60, 15));
btnBike.addEventListener('click', () => applyPresets(40, 15, 60, 90));
btnDrive.addEventListener('click', () => applyPresets(50, 50, 120, 180));

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
