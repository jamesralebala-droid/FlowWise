package com.botwise.flowwise

import android.app.Application
import com.botwise.flowwise.di.AppContainer

class FlowWiseApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
