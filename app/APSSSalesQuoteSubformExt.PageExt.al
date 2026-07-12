pageextension 70303 "APSS Sales Quote Subform Ext" extends "Sales Quote Subform"
{
    actions
    {
        addlast(processing)
        {
            action("APSSUpdateAllItemRefContacts")
            {
                ApplicationArea = All;
                Caption = 'APSS Update All Item Ref Contacts';
                ToolTip = 'Update APSS item reference contact records for every item line in the current sales quote.';
                Image = UpdateXML;

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                begin
                    SyncCU.UpdateAllItemRefContactsForQuote(Rec);
                    CurrPage.Update(true);
                end;
            }

            action("APSSUpdateItemRefContactPrefilled")
            {
                ApplicationArea = All;
                Caption = 'APSS Update Item Ref. Contact';
                ToolTip = 'Open the APSS replacement popup with Reference No. and Long Description prefilled from the APSS sourcing record.';
                Image = UpdateDescription;

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                begin
                    SyncCU.OpenPrefilledItemRefContact(Rec);
                    CurrPage.Update(true);
                end;
            }

            action("APSSShowPopupCopyValues")
            {
                ApplicationArea = All;
                Caption = 'APSS Show Popup Values';
                ToolTip = 'Show the values to copy into the standard Update Item Ref. Contact popup for the selected line.';
                Image = ViewDetails;

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                begin
                    SyncCU.ShowPopupCopyValues(Rec);
                end;
            }
        }
    }
}
