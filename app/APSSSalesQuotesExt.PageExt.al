pageextension 70301 "APSS Sales Quotes Ext" extends "Sales Quotes"
{
    actions
    {
        addlast(processing)
        {
            action("APSSPoscoRfqFeed")
            {
                ApplicationArea = All;
                Caption = 'POSCO RFQ Feed';
                ToolTip = 'View active POSCO RFQs pulled from the Integration Middleware.';
                Image = Web;
                RunObject = Page "APSS POSCO RFQ Feed";
                Promoted = true;
                PromotedCategory = Process;
            }
            action("APSSPttepRfqFeed")
            {
                ApplicationArea = All;
                Caption = 'PTTEP RFQ Feed';
                ToolTip = 'View active PTTEP RFQs pulled from the Integration Middleware.';
                Image = Web;
                RunObject = Page "APSS PTTEP RFQ Feed";
                Promoted = true;
                PromotedCategory = Process;
            }
        }
    }
}
