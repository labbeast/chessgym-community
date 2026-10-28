from collections import Counter

import pytest

import storm_rules as rules


def test_lichess_bucket_cadence_for_the_full_137_puzzle_run():
    windows=[rules.rating_window(i) for i in range(137)]
    assert Counter((w['rating_min'],w['rating_max']) for w in windows)=={
        (1000,1099):7, (1100,1199):7, (1270,1339):8,
        (1410,1479):9, (1550,1619):10, (1690,1759):11,
        (1830,1999):13, (2000,2099):15, (2100,2199):17,
        (2200,2349):19, (2350,2499):21,
    }
    targets=[w['target_rating'] for w in windows]
    assert targets==sorted(targets)
    assert all(w['rating_min']<=w['target_rating']<=w['rating_max'] for w in windows)


@pytest.mark.parametrize('low,high',[(0,4000),(500,900),(1400,1600),(2000,2000),(3000,4000)])
def test_custom_progression_always_respects_explicit_bounds(low,high):
    windows=[rules.rating_window(i,low,high) for i in range(150)]
    assert all(low<=w['rating_min']<=w['target_rating']<=w['rating_max']<=high for w in windows)
    assert [w['target_rating'] for w in windows]==sorted(w['target_rating'] for w in windows)


def test_bonus_counts_player_moves_and_repeats_every_ten_after_thirty():
    assert {i:rules.combo_bonus(i) for i in range(1,101) if rules.combo_bonus(i)}=={
        5:3,12:5,20:7,30:10,40:10,50:10,60:10,70:10,80:10,90:10,100:10,
    }
    assert rules.combo_progress(0)=={'moves':0,'target':5,'remaining':5,'seconds':3}
    assert rules.combo_progress(5)=={'moves':0,'target':7,'remaining':7,'seconds':5}
    assert rules.combo_progress(12)=={'moves':0,'target':8,'remaining':8,'seconds':7}
    assert rules.combo_progress(20)=={'moves':0,'target':10,'remaining':10,'seconds':10}
    assert rules.combo_progress(39)=={'moves':9,'target':10,'remaining':1,'seconds':10}
    assert rules.combo_progress(40)=={'moves':0,'target':10,'remaining':10,'seconds':10}
