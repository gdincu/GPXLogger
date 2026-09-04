# GPX Logger

A highly optimized, battery-efficient Progressive Web App (PWA) that logs your GPS location and generates a downloadable `.gpx` file directly in your browser. All processing happens locally on your device—no data is ever sent to a server.

<img width="303.75" height="675" alt="input1" src="https://github.com/user-attachments/assets/a89f6545-113f-48b8-8be5-9f612e4044c6" />
<img width="303.75" height="675" alt="input2" src="https://github.com/user-attachments/assets/41119551-d86a-485f-b981-1c7b17c03ef8" />

## Features

*   **100% Client-Side & Offline:** No backend, no accounts. Installs directly to your home screen (PWA) and works completely offline.
*   **Dynamic Kalman Filtering:** Applies a 1D Kalman filter to smooth out GPS jitter at walking speeds, but automatically bypasses the filter at speeds >12 km/h to accurately hug road curves while cycling or driving.
*   **Doppler Drift Prevention:** Reads native hardware Doppler speed to completely freeze coordinate logging when you are standing still, preventing "spiderwebbing" at traffic lights.
*   **Battery Optimization:** 
    *   Batches `localStorage` saves to minimize CPU usage.
    *   Pauses visual DOM updates when the screen is locked.
    *   Built-in **OLED Lock Screen** turns off screen pixels while keeping the browser active in the foreground.
*   **Smart Track Segmentation:** Automatically splits your route into new GPX track segments (`<trkseg>`) if you lose GPS signal in a tunnel for >45 seconds or manually pause the app, preventing massive straight lines cutting through maps.
*   **GPS Pre-Lock:** Allows you to warm up the GPS radio and wait for an accurate signal *before* you start recording.
*   **Activity Presets:** One-click configurations for Walking (🚶), Cycling (🚴), and Driving (🚗) that automatically tune the Kalman filter noise and distance thresholds.
*   **Safe OTA Updates:** Built-in update banner notifies you when a new version of the app is available, preventing the Service Worker from force-refreshing and ruining an active tracking session.

## How to Use

1. Open the app in your browser or install it to your home screen.
2. Select an activity preset (or manually adjust your thresholds).
3. (Optional) Tap **Lock GPS Signal** to wait for the accuracy to drop to an acceptable range (e.g., ±5m).
4. Tap **Start Tracking**.
5. (Optional) Tap **Lock Screen** before putting the phone in your pocket to save battery. Slide to unlock when you take it out.
6. Use **Pause Tracking** during long breaks to completely power down the GPS radio and save battery.
7. When finished, tap **Stop & Download** to generate and save your `track_YYYY-MM-DD.gpx` file.

## Important Note on Background Tracking

Because this is a web application, mobile operating systems (iOS and Android) will aggressively suspend the tracking script if you manually lock your phone with the physical power button or switch to another app. 

**To ensure continuous, battery-friendly tracking:**
*   **Do not press your phone's physical power button.** 
*   Instead, tap the in-app **Lock Screen** button at the bottom of the page. 
*   This triggers the built-in Wake Lock API to prevent the phone from sleeping, while covering the screen in pure black to turn off OLED pixels and freeze UI repaints. You can then safely place the phone in your pocket. 
