package com.botwise.flowwise.data.auth

import android.content.Context
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.botwise.flowwise.BuildConfig
import com.botwise.flowwise.data.remote.ApiException
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

data class AuthSession(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Long,
    val orgId: String,
    val defaultBranchId: String?,
)

/**
 * Authorization Code + PKCE (S256) against the FlowWise backend, with the
 * access/refresh tokens kept in EncryptedSharedPreferences. The refresh token
 * is rotated on every use by the server.
 */
class AuthManager(context: Context) {

    private val appContext = context.applicationContext
    private val masterKey = MasterKey.Builder(appContext)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
    private val prefs = EncryptedSharedPreferences.create(
        appContext,
        "flowwise_auth",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    private val http = OkHttpClient()
    private val json = "application/json; charset=utf-8".toMediaType()

    /**
     * Serializes refresh so two flushes can never rotate the same token
     * concurrently (the server revokes a whole family on replay). The stored
     * token is re-read INSIDE the lock, so a queued caller always uses the
     * freshly rotated token.
     */
    private val refreshMutex = Mutex()

    var selectedBranchId: String?
        get() = prefs.getString("selected_branch_id", null)
        set(value) = prefs.edit().putString("selected_branch_id", value).apply()

    val accessToken: String? get() = prefs.getString("access_token", null)
    val isLoggedIn: Boolean get() = accessToken != null

    suspend fun login(username: String, password: String): AuthSession = withContext(Dispatchers.IO) {
        val verifier = randomVerifier()
        val challenge = pkceChallenge(verifier)

        val authorizeBody = JSONObject()
            .put("username", username)
            .put("password", password)
            .put("clientId", CLIENT_ID)
            .put("codeChallenge", challenge)
            .put("codeChallengeMethod", "S256")

        val code = postJson("/oauth/authorize", authorizeBody).getString("code")

        val tokenBody = JSONObject()
            .put("grantType", "authorization_code")
            .put("code", code)
            .put("codeVerifier", verifier)
            .put("clientId", CLIENT_ID)

        val token = postJson("/oauth/token", tokenBody)
        val access = token.getString("access_token")
        val refresh = token.getString("refresh_token")

        // First authenticated call — profile + branch scope (Phase 0 exit).
        val me = getJson("/me", access)
        val org = me.getJSONObject("org")
        val defaultBranch = if (me.isNull("defaultBranch")) null else me.getString("defaultBranch")

        persist(access, refresh, token.optLong("expires_in", 900L))
        AuthSession(access, refresh, token.optLong("expires_in", 900L), org.getString("id"), defaultBranch)
    }

    /** First authenticated call — profile, roles and branch scope. */
    suspend fun me(): JSONObject {
        val token = accessToken ?: throw IllegalStateException("Not logged in")
        return withContext(Dispatchers.IO) { getJson("/me", token) }
    }

    /**
     * Rotates the refresh token (the server rotates on every use) and persists
     * the new pair. Returns true when a fresh session is stored.
     *
     * A 4xx means the refresh token itself is dead (expired, revoked, or the
     * family was killed by a replay) — the session is cleared and the user must
     * log in again. Network/5xx failures keep the session so a later flush can
     * retry.
     */
    suspend fun refresh(): Boolean = withContext(Dispatchers.IO) {
        refreshMutex.withLock {
            val stored = prefs.getString("refresh_token", null) ?: return@withLock false
            try {
                val body = JSONObject()
                    .put("grantType", "refresh_token")
                    .put("refreshToken", stored)
                    .put("clientId", CLIENT_ID)
                val token = postJson("/oauth/token", body)
                persist(
                    token.getString("access_token"),
                    token.getString("refresh_token"),
                    token.optLong("expires_in", 900L),
                )
                true
            } catch (e: ApiException) {
                if (e.code in 400..499) {
                    // Token invalid/revoked/reuse-detected: session is over.
                    prefs.edit().clear().apply()
                }
                false
            } catch (e: Exception) {
                false // network hiccup — keep the session, retry later
            }
        }
    }

    fun logout() {
        prefs.edit().clear().apply()
    }

    private fun persist(access: String, refresh: String, expiresIn: Long) {
        prefs.edit()
            .putString("access_token", access)
            .putString("refresh_token", refresh)
            .putLong("expires_at", System.currentTimeMillis() + expiresIn * 1000)
            .apply()
    }

    private fun randomVerifier(): String =
        Base64.encodeToString(UUID.randomUUID().toString().toByteArray(), Base64.NO_WRAP)
            .trimEnd('=')

    private fun pkceChallenge(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray())
        return Base64.encodeToString(digest, Base64.NO_WRAP).trimEnd('=')
    }

    private fun postJson(path: String, body: JSONObject): JSONObject {
        val request = Request.Builder()
            .url(BuildConfig.API_BASE_URL + path)
            .post(body.toString().toRequestBody(json))
            .build()
        return execute(request)
    }

    private fun getJson(path: String, token: String): JSONObject {
        val request = Request.Builder()
            .url(BuildConfig.API_BASE_URL + path)
            .header("Authorization", "Bearer $token")
            .build()
        return execute(request)
    }

    private fun execute(request: Request): JSONObject {
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val obj = if (text.isEmpty()) JSONObject() else JSONObject(text)
            if (!response.isSuccessful) {
                throw ApiException(response.code, obj.optString("message", "HTTP ${response.code}"))
            }
            return obj
        }
    }

    private companion object {
        const val CLIENT_ID = "flowwise-app"
    }
}
