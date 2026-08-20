# GPX Logger

A lightweight, Progressive Web App (PWA) that logs your GPS location and generates a downloadable `.gpx` file directly in your browser. All processing happens locally on your device—no data is ever sent to a server.

## Features

*   **100% Client-Side:** No backend, no accounts, and no data tracking.
*   **Offline Capable (PWA):** Installs directly to your home screen and works without an internet connection.
*   **Smart Filtering:** Uses the Haversine formula to filter out GPS drift (spiderwebbing) when standing still.
*   **Activity Presets:** One-click configurations for Walking (🚶), Cycling (🚴), and Driving (🚗).
*   **Auto-Recovery:** Periodically saves route data to `localStorage` to prevent data loss if the browser crashes or the tab is closed.
*   **Wake Lock API:** Automatically prevents the device screen from going to sleep while actively tracking.
*   **Custom Thresholds:** Fine-tune accuracy limits, minimum distance to log, stationary time overrides, and speed sanity checks.

## How to Use

1. Host the files on a secure server (`https://`) or run them via a local development server (`http://localhost`). *Note: Geolocation and Service Workers will not work over the `file:///` protocol.*
2. Open the app in your browser or install it to your home screen.
3. Select an activity preset (or manually adjust your thresholds).
4. Tap **Start Tracking**.
5. When finished, tap **Stop & Download** to generate and save your `track_YYYY-MM-DD.gpx` file.

## Important Note on Background Tracking

Because this is a web application, mobile operating systems (iOS and Android) will aggressively suspend the tracking script if you manually turn off your screen or minimize the browser. 

**To ensure continuous tracking:**
*   Leave the app open in the foreground (the built-in Wake Lock will keep the screen on).
*   *Android Workaround:* You can use a third-party app like [ProximityService](https://github.com/ssaqua/ProximityService) to turn off the physical display while keeping the CPU and browser active in your pocket.
