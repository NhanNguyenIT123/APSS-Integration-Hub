pageextension 70301 "APSS Sales Quotes Ext" extends "Sales Quotes"
{
    actions
    {
        addlast(processing)
        {
            action("APSSRfqFeed")
            {
                ApplicationArea = All;
                Caption = 'APSS RFQ Feed';
                ToolTip = 'View active RFQs pulled from the Integration Middleware.';
                Image = Web;
                RunObject = Page "APSS RFQ Feed";
                Promoted = true;
                PromotedCategory = Process;
            }
        }
    }
}
