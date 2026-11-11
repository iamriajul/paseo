# Server browser video: device check

Working note for testing native H.264 video (`feat/server-browser-video-native`) on a phone before it ships. Delete it once the check passes; what it finds goes into [server-browser.md](server-browser.md).

## Before you start

- A host on this build with Settings → host → Agents → Server-side browser on, engine **Managed Chrome** (Headless or Window).
- The phone app built from this branch (the CI APK, or a TestFlight build for iPhone).
- A page that moves, open in a server tab: for example a CSS animation demo, or any long page you can scroll.

## Steps

1. **Install and open.** The app starts. Open the workspace and its server browser tab. The page appears within about two seconds.
2. **It is video.** Scroll the page with a drag. Motion is smooth (about 60 fps on Wi-Fi), not the stepped look of JPEG. Text is sharp once the page stops.
3. **Shape.** The page fits the panel with dark bars where the shapes differ, never stretched. Rotate the phone, and open and close the side panel: the page re-fits each time.
4. **Input lines up.** Tap a link: the click lands where you tapped. Long press: a right-click lands there. Open the keyboard bar and type: the text reaches the page.
5. **Annotate.** Tap Annotate element and pick an element. The highlight follows your finger and the pick attaches the right element. The video keeps playing afterwards.
6. **Background.** Press Home, wait 10 seconds, come back. The page plays again within about a second. Do the same with the screen locked for 10 seconds.
7. **Switch away and back.** Open another workspace tab, then the server tab again. Then another workspace, and back. Video resumes each time, with no black panel.
8. **Slow network.** Turn Wi-Fi off and use mobile data (or a weak Wi-Fi spot). The page keeps moving, maybe less smoothly, and does not freeze for more than a moment.
9. **JPEG still works.** On the host, switch the engine to **Headless (light)**. Reopen the tab: the page shows (as JPEG, steppier motion). Switch back to Managed Chrome afterwards.
10. **Leave it.** Close the server tab. Nothing keeps playing, and the phone does not stay warm.

## If something fails

Note the step, the phone model and OS version, and what you saw. Send `$PASEO_HOME/daemon.log` from the host, filtered to the minute it happened (lines with `Server browser video` say why video stopped). On Android, `adb logcat | grep -iE "mediacodec|codec2|paseo"` from that minute helps. On iPhone, the Xcode console shows VideoToolbox status codes.

Run steps 2, 3 and 8 on two Android phones from different makers if you can (for example a Pixel or Samsung, and a phone with a MediaTek chip): their hardware decoders behave differently.
