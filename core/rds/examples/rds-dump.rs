//! Differential harness: read one hex group per line on stdin, print the decoder
//! state after each. Paired with tools/tests/rdsDump.mjs, which prints the same
//! shape from the TypeScript decoder, so the two can be diffed line for line.
//!
//! The formatting itself is `carfm_rds::format_state`, shared with the Android
//! JNI adapter so a device capture can be diffed against this output directly.
use carfm_rds::{format_state, RdsDecoder};
use std::io::{self, BufRead};

fn main() {
    let mut d = RdsDecoder::new();
    for line in io::stdin().lock().lines() {
        let l = line.unwrap_or_default();
        let g = l.trim();
        if g.is_empty() {
            continue;
        }
        if g == "!reset" {
            d.reset();
        } else if g == "!retune" {
            d.reset_for_retune();
        } else if g == "!clearta" {
            d.clear_ta();
        } else {
            d.push(g);
        }
        println!("{}", format_state(&d.state(), &d.stats(), &d.quality()));
    }
}
