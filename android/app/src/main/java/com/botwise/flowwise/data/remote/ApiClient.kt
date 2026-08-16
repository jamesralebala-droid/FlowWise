package com.botwise.flowwise.data.remote

import android.content.Context
import com.botwise.flowwise.BuildConfig
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Thin OkHttp + org.json client. The backend is OAuth2/PKCE over REST /v1.
 * Every mutating call can carry an Idempotency-Key (Invariant 4) so a retried
 * upload after a dropped connection never produces a duplicate.
 */
class ApiClient(context: Context) {

    private val baseUrl: String = BuildConfig.API_BASE_URL
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = "application/json; charset=utf-8".toMediaType()

    suspend fun post(path: String, body: JSONObject, token: String?, idempotencyKey: String? = null): JSONObject =
        call("POST", path, body, token, idempotencyKey)

    suspend fun get(path: String, token: String): JSONObject = call("GET", path, null, token, null)

    private suspend fun call(
        method: String,
        path: String,
        body: JSONObject?,
        token: String?,
        idempotencyKey: String?,
    ): JSONObject {
        val builder = Request.Builder()
            .url(baseUrl + path)
            .method(method, body?.toString()?.toRequestBody(json))
        if (token != null) builder.header("Authorization", "Bearer $token")
        if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey)

        val response = withContext(Dispatchers.IO) { client.newCall(builder.build()).execute() }
        response.use {
            val text = it.body?.string().orEmpty()
            val obj = if (text.isEmpty()) JSONObject() else JSONObject(text)
            if (!it.isSuccessful) {
                throw ApiException(it.code, obj.optString("message", it.message ?: "HTTP ${it.code}"))
            }
            return obj
        }
    }
}

class ApiException(val code: Int, message: String) : Exception(message)
