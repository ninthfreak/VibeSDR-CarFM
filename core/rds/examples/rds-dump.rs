//! Differential harness: read one hex group per line on stdin, print the decoder
//! state after each. Paired with tools/tests/rdsDump.mjs, which prints the same
//! shape from the TypeScript decoder, so the two can be diffed line for line.
use carfm_rds::RdsDecoder;
use std::io::{self, BufRead};

fn main() {
    let mut d = RdsDecoder::new();
    for line in io::stdin().lock().lines() {
        let l = line.unwrap();
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
        let s = d.state();
        let t = d.stats();
        let q = d.quality();
        println!(
            "pi={} pty={} tp={} ta={} ps={:?} rt={:?} scroll={} art={:?} tit={:?} g={} x={} q={} n={}",
            s.pi.map(|v| format!("{v:04x}")).unwrap_or("-".into()),
            s.pty.map(|v| v.to_string()).unwrap_or("-".into()),
            s.tp, s.ta, s.ps, s.rt, s.ps_scrolling, s.rt_artist, s.rt_title,
            t.groups, t.pi_mismatch,
            q.pi_match_pct.map(|v| v.to_string()).unwrap_or("-".into()),
            q.samples
        );
    }
}
