package com.nwd.radio.service.data;

import android.os.Parcel;
import android.os.Parcelable;

/**
 * Interop reconstruction of com.nwd.radio.service.data.RadioPoint — the band
 * plan (min / max / step for the current band). Three ints; read in field
 * declaration order (max, min, step). All ints, so even if the labelling is
 * swapped the values still unmarshal cleanly — the spike prints all three raw.
 */
public class RadioPoint implements Parcelable {
    public int max;
    public int min;
    public int step;

    public RadioPoint() {}

    protected RadioPoint(Parcel in) {
        max = in.readInt();
        min = in.readInt();
        step = in.readInt();
    }

    @Override
    public void writeToParcel(Parcel d, int flags) {
        d.writeInt(max);
        d.writeInt(min);
        d.writeInt(step);
    }

    @Override
    public int describeContents() { return 0; }

    public static final Creator<RadioPoint> CREATOR = new Creator<RadioPoint>() {
        @Override public RadioPoint createFromParcel(Parcel in) { return new RadioPoint(in); }
        @Override public RadioPoint[] newArray(int size) { return new RadioPoint[size]; }
    };

    @Override
    public String toString() {
        return "RadioPoint{a=" + max + ", b=" + min + ", c=" + step + "}";
    }
}
