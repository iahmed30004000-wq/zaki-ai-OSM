package io.zakiai.callhelper

import org.json.JSONException
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** What the server answered. */
sealed class Reply {
    class Ok(val json: JSONObject) : Reply()

    /** A non-2xx answer; [error] is the server's Arabic sentence when it sent one. */
    class Refused(val code: Int, val error: String?) : Reply()

    /** The request never got an answer (no network, timeout, TLS). */
    object Failed : Reply()
}

/**
 * THE ONLY NETWORK CODE IN THE APP.
 *
 * It talks to the one base she paired with, over https (the network security
 * config refuses plain http in a release build). No redirects are followed,
 * so the bearer token never reaches a host it was not issued by.
 */
object Api {
    fun post(url: String, body: JSONObject, token: String?): Reply {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 15_000
                doOutput = true
                instanceFollowRedirects = false
                useCaches = false
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                if (token != null) setRequestProperty("Authorization", "Bearer $token")
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            val json = try {
                JSONObject(text)
            } catch (e: JSONException) {
                null
            }
            if (code in 200..299) {
                Reply.Ok(json ?: JSONObject())
            } else {
                Reply.Refused(code, json?.optString("error")?.takeIf { it.isNotBlank() })
            }
        } catch (e: Exception) {
            Reply.Failed
        } finally {
            conn?.disconnect()
        }
    }
}
