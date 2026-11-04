package io.zakiai.callhelper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The shapes a `zakicall://` link may carry (docs/call-helper/CONTRACT.md). */
class LinksTest {
    @Test
    fun anHttpsOriginIsKeptAsAnOrigin() {
        assertEquals("https://crm.zakiai.io", Links.origin("https://crm.zakiai.io", debug = false))
        assertEquals("https://crm.zakiai.io", Links.origin("https://crm.zakiai.io/", debug = false))
        assertEquals("https://crm.zakiai.io", Links.origin("HTTPS://CRM.ZakiAI.io", debug = false))
        assertEquals("https://crm.zakiai.io:8443", Links.origin("https://crm.zakiai.io:8443", debug = false))
    }

    @Test
    fun plainHttpIsRefusedInRelease() {
        assertNull(Links.origin("http://crm.zakiai.io", debug = false))
        assertNull(Links.origin("http://10.0.2.2:3001", debug = false))
        assertNull(Links.origin("http://localhost:3001", debug = false))
    }

    @Test
    fun debugAllowsHttpOnlyToTheEmulatorHostAndLocalhost() {
        assertEquals("http://10.0.2.2:3001", Links.origin("http://10.0.2.2:3001", debug = true))
        assertEquals("http://localhost:3001", Links.origin("http://localhost:3001", debug = true))
        assertNull(Links.origin("http://crm.zakiai.io", debug = true))
        assertNull(Links.origin("http://192.168.1.5:3001", debug = true))
    }

    @Test
    fun anythingThatIsNotAnOriginIsRefusedNotTrimmed() {
        assertNull(Links.origin("https://crm.zakiai.io/api", debug = false))
        assertNull(Links.origin("https://crm.zakiai.io?x=1", debug = false))
        assertNull(Links.origin("https://crm.zakiai.io#x", debug = false))
        assertNull(Links.origin("https://user@crm.zakiai.io", debug = false))
        assertNull(Links.origin("ftp://crm.zakiai.io", debug = false))
        assertNull(Links.origin("javascript:alert(1)", debug = false))
        assertNull(Links.origin("crm.zakiai.io", debug = false))
        assertNull(Links.origin("", debug = false))
        assertNull(Links.origin(null, debug = false))
    }

    @Test
    fun theHostIsWhatTheQuestionShows() {
        assertEquals("crm.zakiai.io", Links.host("https://crm.zakiai.io"))
    }

    @Test
    fun aPairCodeIsThirtyTwoUrlSafeCharacters() {
        assertTrue(Links.isPairCode("abcdefghijABCDEFGHIJ0123456789_-"))
        assertFalse(Links.isPairCode("abcdefghijABCDEFGHIJ0123456789_"))
        assertFalse(Links.isPairCode("abcdefghijABCDEFGHIJ0123456789_-x"))
        assertFalse(Links.isPairCode("abcdefghijABCDEFGHIJ012345678/_-"))
        assertFalse(Links.isPairCode(null))
    }

    @Test
    fun anOrderIdAndAPhoneHaveTheirShapes() {
        assertTrue(Links.isOrderId("clx9a8b7c0000abcd1234"))
        assertFalse(Links.isOrderId(""))
        assertFalse(Links.isOrderId("a/b"))
        assertFalse(Links.isOrderId("x".repeat(65)))

        assertTrue(Links.isPhone("963933123456"))
        assertFalse(Links.isPhone("+963933123456"))
        assertFalse(Links.isPhone("0933 123 456"))
        assertFalse(Links.isPhone("12345"))
        assertFalse(Links.isPhone("1".repeat(16)))
        assertFalse(Links.isPhone(null))
    }
}
