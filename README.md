SSTV Web Emulator

This is a browser-only, educational SSTV (Slow Scan TV) emulator. It encodes images to audio and performs a very simple decoding of audio back into a grayscale image. It is intentionally simplified and does NOT implement full SSTV protocols. 

Important: This project does NOT connect to radio hardware and must not be used to transmit on-air unless you have the required licences and comply with local regulations.

If you want the decoded canvases (live or uploaded) to always render at a specific CSS pixel density (e.g., scale by devicePixelRatio, retina), I can add that option.

For better color accuracy and noise robustness, switching part of the detector from Goertzel/centroid to an FFT-based peak finder (using the included fft.js) will help with weak/noisy signals.


