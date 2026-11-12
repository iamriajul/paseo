package sh.paseo.browserproxy

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps Paseo's process in the foreground while "Open on this phone" forwards are open, so
 * Android neither freezes it nor cuts its network when the user switches to their browser.
 * The forwards themselves are PortForwardListeners; this service only holds the foreground
 * state and the notification, whose Stop action ends every forward.
 */
class PortForwardService : Service() {
  companion object {
    private const val ACTION_SHOW = "sh.paseo.browserproxy.PORT_FORWARD_SHOW"
    private const val ACTION_STOP = "sh.paseo.browserproxy.PORT_FORWARD_STOP"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_STOP_LABEL = "stopLabel"
    private const val CHANNEL_ID = "paseo-port-forward"
    private const val NOTIFICATION_ID = 0x5f0a

    /** Set by the module: ends every forward when the notification's Stop is pressed. */
    @Volatile
    internal var onStopRequested: (() -> Unit)? = null

    /** Must be called while the app is in the foreground (Android 12+ start restrictions). */
    internal fun show(context: Context, title: String, text: String, stopLabel: String) {
      val intent = Intent(context, PortForwardService::class.java)
        .setAction(ACTION_SHOW)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_TEXT, text)
        .putExtra(EXTRA_STOP_LABEL, stopLabel)
      androidx.core.content.ContextCompat.startForegroundService(context, intent)
    }

    internal fun hide(context: Context) {
      context.stopService(Intent(context, PortForwardService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      onStopRequested?.invoke()
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Paseo"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    val stopLabel = intent?.getStringExtra(EXTRA_STOP_LABEL) ?: "Stop"
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      buildNotification(title, text, stopLabel),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      } else {
        0
      },
    )
    // Forwards do not survive the process: a restarted service would hold nothing open.
    return START_NOT_STICKY
  }

  private fun buildNotification(title: String, text: String, stopLabel: String): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Port forwarding", NotificationManager.IMPORTANCE_LOW),
      )
    }
    val stopIntent = PendingIntent.getService(
      this,
      0,
      Intent(this, PortForwardService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      PendingIntent.getActivity(
        this,
        1,
        launch,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    }
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .apply { if (openIntent != null) setContentIntent(openIntent) }
      .addAction(0, stopLabel, stopIntent)
      .build()
  }
}
