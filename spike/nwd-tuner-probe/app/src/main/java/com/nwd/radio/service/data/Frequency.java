package com.nwd.radio.service.data;

import android.os.Parcel;
import android.os.Parcelable;

/**
 * Interop reconstruction of com.nwd.radio.service.data.Frequency.
 * Parcel WIRE ORDER (verified from the service's writeToParcel): byte band,
 * String psName, int freq — NOT the field declaration order. Must match exactly
 * or unmarshalling of getCurrentFrequency() / notifyPrefabFrequency() breaks.
 */
public class Frequency implements Parcelable {
    public byte band;
    public String psName;
    public int freq;

    public Frequency() {}

    protected Frequency(Parcel in) {
        band = in.readByte();
        psName = in.readString();
        freq = in.readInt();
    }

    @Override
    public void writeToParcel(Parcel d, int flags) {
        d.writeByte(band);
        d.writeString(psName);
        d.writeInt(freq);
    }

    @Override
    public int describeContents() { return 0; }

    public static final Creator<Frequency> CREATOR = new Creator<Frequency>() {
        @Override public Frequency createFromParcel(Parcel in) { return new Frequency(in); }
        @Override public Frequency[] newArray(int size) { return new Frequency[size]; }
    };

    @Override
    public String toString() {
        return "Frequency{band=" + band + ", freq=" + freq + ", ps=" + psName + "}";
    }
}
