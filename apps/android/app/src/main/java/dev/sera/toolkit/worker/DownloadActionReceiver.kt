package dev.sera.toolkit.worker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.sera.toolkit.SeraApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class DownloadActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_CANCEL_DOWNLOAD) return
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        val app = context.applicationContext as? SeraApplication ?: return
        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                app.downloadCoordinator.cancelTask(taskId)
            } finally {
                pendingResult.finish()
            }
        }
    }

    companion object {
        const val ACTION_CANCEL_DOWNLOAD = "dev.sera.toolkit.action.CANCEL_DOWNLOAD"
        const val EXTRA_TASK_ID = "extra_task_id"
    }
}
