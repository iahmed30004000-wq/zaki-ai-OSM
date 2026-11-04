package io.zakiai.callhelper

import android.app.Activity
import android.content.Context
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * THE FEW VIEWS THE APP DRAWS, BUILT IN CODE.
 *
 * Right to left whatever the phone's language is: the words are Arabic, so
 * the page reads from the right even on a phone set to English.
 */
object Ui {
    fun dp(c: Context, v: Int): Int = (v * c.resources.displayMetrics.density).toInt()

    /** A scrolling right-to-left column that becomes the activity's whole page. */
    fun page(a: Activity): LinearLayout {
        val column = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            layoutDirection = View.LAYOUT_DIRECTION_RTL
            val pad = dp(a, 20)
            setPadding(pad, pad, pad, pad)
        }
        val scroll = ScrollView(a).apply {
            layoutDirection = View.LAYOUT_DIRECTION_RTL
            addView(column, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        a.setContentView(scroll)
        return column
    }

    fun text(c: Context, s: CharSequence, sizeSp: Float = 16f, color: Int? = null, bold: Boolean = false): TextView =
        TextView(c).apply {
            text = s
            textSize = sizeSp
            if (color != null) setTextColor(c.getColor(color))
            if (bold) setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.START
            textDirection = View.TEXT_DIRECTION_RTL
            textAlignment = View.TEXT_ALIGNMENT_VIEW_START
            layoutDirection = View.LAYOUT_DIRECTION_RTL
            setPadding(0, dp(c, 6), 0, dp(c, 6))
        }

    fun button(c: Context, s: CharSequence, onClick: () -> Unit): Button =
        Button(c).apply {
            text = s
            isAllCaps = false
            setOnClickListener { onClick() }
        }

    /** A thin gap between sections. */
    fun gap(c: Context, heightDp: Int = 12): View = View(c).apply {
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(c, heightDp))
    }
}
