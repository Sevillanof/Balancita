"""One definition of a hit (SS-02), shared by the simulator, E and Qwen's score.

* trade hit: the trade's net P&L after the shared costs is positive.
* decision hit: the price moved the way the decision said by the strategy's own
  horizon, judged on gross movement (costs are the trade's business).
"""

from decimal import Decimal

TEN_THOUSAND = Decimal(10_000)


def trade_hit(net):
    return Decimal(str(net)) > 0


def gross_bp(side, reference, outcome):
    """Signed movement in bp in the direction of ``side`` ("LONG"/"SHORT")."""
    reference, outcome = Decimal(str(reference)), Decimal(str(outcome))
    move = (outcome - reference) / reference * TEN_THOUSAND
    return move if side == "LONG" else -move


def direction_hit(side, reference, outcome):
    return gross_bp(side, reference, outcome) > 0
